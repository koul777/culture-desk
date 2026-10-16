import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { retryTransientCollectionFailures } from '../scripts/retry-national.js';

function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE sync_runs(id INTEGER PRIMARY KEY,state TEXT,error TEXT,updated_at TEXT);
    CREATE TABLE sync_tasks(id INTEGER PRIMARY KEY,run_id INTEGER,kind TEXT,city_id TEXT,state TEXT,attempts INTEGER,available_at TEXT,error TEXT);`);
  const cases = [
    ['failed', '제공기관 연결에 실패했습니다. 잠시 후 다시 시도합니다.', 'partial'],
    ['running', '제공기관 연결에 실패했습니다.', 'running'],
    ['done', '', 'complete'],
    ['failed', '제공기관 응답 형식을 확인할 수 없습니다.', 'partial'],
    ['queued', '인증키가 거절되었습니다.', 'partial'],
    ['queued', '제공기관 호출 한도에 도달했습니다.', 'quota_wait'],
  ];
  cases.forEach(([state, error, runState], index) => {
    db.prepare('INSERT INTO sync_runs VALUES(?,?,?,?)').run(index + 1, runState, error, 'before');
    db.prepare('INSERT INTO sync_tasks VALUES(?,?,?,?,?,?,?,?)').run(index + 1, index + 1, 'list', 'test-city', state, 3, 'before', error);
  });
  return db;
}

test('national recovery only requeues failed network tasks and preserves live, complete, schema and provider-halted work', () => {
  const db = fixture();
  try {
    const before = db.prepare('SELECT * FROM sync_tasks WHERE id!=1').all();
    const runsBefore = db.prepare('SELECT * FROM sync_runs WHERE id!=1').all();
    const now = Date.UTC(2026, 9, 16);
    const result = retryTransientCollectionFailures(db, now);
    assert.equal(result.requeued, 1);
    assert.equal(result.availableAt, '2026-10-16T00:00:10.000Z');
    assert.deepEqual(db.prepare('SELECT * FROM sync_tasks WHERE id!=1').all(), before);
    assert.deepEqual(db.prepare('SELECT * FROM sync_runs WHERE id!=1').all(), runsBefore);
    const task = db.prepare('SELECT state,attempts,available_at FROM sync_tasks WHERE id=1').get()!;
    assert.equal(task.state, 'queued'); assert.equal(task.attempts, 0); assert.equal(task.available_at, result.availableAt);
    assert.equal(db.prepare('SELECT state FROM sync_runs WHERE id=1').get()?.state, 'queued');
  } finally { db.close(); }
});

test('national recovery stops after two durable extra rounds for a repeatedly failed task', () => {
  const db = fixture();
  try {
    for (let round = 0; round < 3; round++) {
      db.prepare("UPDATE sync_tasks SET state='failed',attempts=3,error='제공기관 연결에 실패했습니다.' WHERE id=1").run();
      db.prepare("UPDATE sync_runs SET state='partial' WHERE id=1").run();
      assert.equal(retryTransientCollectionFailures(db).requeued, round < 2 ? 1 : 0);
    }
    assert.equal(db.prepare('SELECT rounds FROM collection_retries WHERE task_id=1').get()?.rounds, 2);
    assert.equal(db.prepare('SELECT state FROM sync_tasks WHERE id=1').get()?.state, 'failed');
    assert.equal(db.prepare('SELECT state FROM sync_runs WHERE id=1').get()?.state, 'partial');
  } finally { db.close(); }
});
