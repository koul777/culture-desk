import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import ExcelJS from 'exceljs';
import { SnapshotRepository, SnapshotCapacityError, MAX_SNAPSHOT_BYTES, MAX_DATABASE_BYTES, encodeSnapshot, decodeSnapshot, type SnapshotClient, type SnapshotPool } from '../server/cloud/snapshot.js';
import { equalSecret, validMutationOrigin } from '../server/cloud/auth.js';
import { handleCloudRequest, MAX_API_RESPONSE_BYTES } from '../server/cloud/handler.js';
import { DEFAULT_CITIES } from '../server/providers/cities.js';
import { Store } from '../server/store.js';
import { createApp } from '../server/app.js';
import type { PerformanceInput, Provider } from '../shared/types.js';

// Models the PostgreSQL lock/commit boundary while exercising real SQLite files and Fastify routes.
class TransactionPool implements SnapshotPool {
  bytes: Buffer | null = null;
  writes = 0;
  active = 0;
  maxActive = 0;
  failWrite = false;
  private pending: Promise<void> = Promise.resolve();
  async connect(): Promise<SnapshotClient> {
    let unlock: (() => void) | undefined;
    let staged: Buffer | undefined;
    const owner = this;
    return {
      async query(text, values = []) {
        if (text.includes('FOR UPDATE')) {
          const previous = owner.pending;
          owner.pending = new Promise<void>(resolve => { unlock = resolve; });
          await previous;
          owner.active++; owner.maxActive = Math.max(owner.maxActive, owner.active);
        }
        if (text.startsWith('SELECT data')) return { rows: [{ data: owner.bytes }] };
        if (text.startsWith('UPDATE culture_desk_snapshot')) {
          if (owner.failWrite) throw new Error('simulated persistence failure');
          staged = Buffer.from(values[0]); return { rows: [], rowCount: 1 };
        }
        if (text === 'COMMIT') {
          if (staged) { owner.bytes = staged; owner.writes++; }
          if (unlock) { owner.active--; unlock(); unlock = undefined; }
        }
        if (text === 'ROLLBACK' && unlock) { owner.active--; unlock(); unlock = undefined; }
        return { rows: [] };
      },
      release() { assert.equal(unlock, undefined, 'the PostgreSQL transaction must finish before releasing its client'); },
    };
  }
}
const env = { CRON_SECRET: 'TEST_CRON_SECRET', KOPIS_API_KEY: 'TEST_KEY_NO_NETWORK' };
const request = (route: string, method = 'GET', body?: unknown, extra: Record<string,string> = {}) => new Request(`https://culture.test${route}`, {
  method,
  headers: { ...(body !== undefined ? { 'content-type': 'application/json', 'x-culture-request': '1' } : {}), ...extra },
  ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
});

test('cron secrets must match and an unconfigured secret never authenticates', () => {
  assert.equal(equalSecret('TEST_CRON_SECRET', 'TEST_CRON_SECRET'), true);
  assert.equal(equalSecret('TEST_WRONG_SECRET', 'TEST_CRON_SECRET'), false);
  assert.equal(equalSecret('', ''), false);
});

test('cloud mutation origin protection rejects cross-site and missing request marker', () => {
  assert.equal(validMutationOrigin(request('/api/sync', 'POST', {}, { origin: 'https://evil.test' })), false);
  assert.equal(validMutationOrigin(request('/api/sync', 'POST', {}, { 'sec-fetch-site': 'cross-site' })), false);
  assert.equal(validMutationOrigin(new Request('https://culture.test/api/sync', { method: 'POST' })), false);
  assert.equal(validMutationOrigin(request('/api/sync', 'POST', {}, { origin: 'https://culture.test' })), true);
});

test('cloud snapshots serialize concurrent writers and preserve both mutations', async () => {
  const pool = new TransactionPool(); const repo = new SnapshotRepository(pool);
  await Promise.all([
    repo.withStore(true, async store => { store.addCity({ ...DEFAULT_CITIES[0], id: 'test-first' }); await new Promise(resolve => setTimeout(resolve, 40)); }),
    repo.withStore(true, async store => { store.addCity({ ...DEFAULT_CITIES[0], id: 'test-second' }); }),
  ]);
  assert.equal(pool.maxActive, 1); assert.equal(pool.writes, 2);
  await repo.withStore(false, async store => {
    assert.ok(store.cities().some(city => city.id === 'test-first'));
    assert.ok(store.cities().some(city => city.id === 'test-second'));
  });
});

test('failed cloud mutation cannot replace the last durable snapshot', async () => {
  const pool = new TransactionPool(); const repo = new SnapshotRepository(pool);
  await repo.withStore(true, async store => { store.addCity({ ...DEFAULT_CITIES[0], id: 'test-kept' }); });
  const before = Buffer.from(pool.bytes!);
  await assert.rejects(repo.withStore(true, async store => { store.addCity({ ...DEFAULT_CITIES[0], id: 'test-rolled-back' }); throw new Error('simulated failure'); }));
  assert.deepEqual(pool.bytes, before); assert.equal(pool.writes, 1);
  await repo.withStore(false, async store => { assert.equal(store.cities().some(city => city.id === 'test-rolled-back'), false); });
  pool.failWrite = true;
  await assert.rejects(repo.withStore(true, async store => { store.addCity({ ...DEFAULT_CITIES[0], id: 'test-persist-failure' }); }));
  assert.deepEqual(pool.bytes, before); assert.equal(pool.writes, 1);
  pool.failWrite = false;
  await repo.withStore(false, async store => { assert.equal(store.cities().some(city => city.id === 'test-persist-failure'), false); });
});

test('cloud search is public without password configuration or cookies and cron remains authenticated', async () => {
  const repo = new SnapshotRepository(new TransactionPool()); const options = { env, repository: repo, providers: {} };
  let response = await handleCloudRequest(request('/api/bootstrap'), options);
  assert.equal(response.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
  assert.equal(response.status, 200); const boot = await response.text(); assert.match(boot, /"deployment":"cloud"/); assert.ok(!boot.includes(env.KOPIS_API_KEY));
  assert.equal(response.headers.has('set-cookie'), false);
  for(const route of ['/api/performances','/api/map','/api/export.xlsx'])assert.equal((await handleCloudRequest(request(route),options)).status,200);
  for(const method of ['GET','POST','DELETE'])assert.equal((await handleCloudRequest(request('/api/auth',method,method==='GET'?undefined:{}),options)).status,404);
  response = await handleCloudRequest(request('/api/cloud/cron'), options); assert.equal(response.status, 401);
  response = await handleCloudRequest(request('/api/cloud/cron', 'POST', {}, { authorization: `Bearer ${env.CRON_SECRET}` }), options); assert.equal(response.status, 401);
  response = await handleCloudRequest(request('/api/cloud/cron', 'GET', undefined, { authorization: `Bearer ${env.CRON_SECRET}` }),options);assert.equal(response.status,200);
  response = await handleCloudRequest(request('/api/cloud/cron', 'GET', undefined, { authorization: 'Bearer ' }), {...options,env:{}});assert.equal(response.status,401);
});

test('cloud tick commits completed queue work and aborts a slow provider without losing its task', async () => {
  const repo = new SnapshotRepository(new TransactionPool());
  await repo.withStore(true, async store => { store.createRun('kopis', 'andong', '2026-10-01', '2026-10-31'); });
  let receivedAbort = false;
  const slow: Provider = { source: 'kopis', detail: async item => item, list: async (_input, signal) => new Promise((_resolve, reject) => {
    signal?.addEventListener('abort', () => { receivedAbort = true; reject(new Error('aborted')); }, { once: true });
  }) };
  // The batch budget includes snapshot I/O and the 350ms cross-request cooldown; the task still gets only 30ms.
  const response = await handleCloudRequest(request('/api/cloud/tick', 'POST', {}), { env, repository: repo, providers: { kopis: slow }, tickStepMs: 30, tickBudgetMs: 800 });
  assert.equal(response.status, 200); assert.equal(receivedAbort, true);
  await repo.withStore(false, async store => {
    const row = store.db.prepare('SELECT state,attempts,available_at FROM sync_tasks').get()!;
    assert.equal(row.state, 'queued'); assert.equal(row.attempts, 1); assert.ok(Date.parse(String(row.available_at)) > Date.now());
  });
  await repo.withStore(true, async store => { store.db.prepare("UPDATE sync_tasks SET available_at='2000-01-01T00:00:00.000Z'").run(); });
  const quick: Provider = { ...slow, list: async () => ({ items: [], hasMore: false }) };
  const done = await handleCloudRequest(request('/api/cloud/tick', 'POST', {}), { env, repository: repo, providers: { kopis: quick } });
  assert.equal(done.status, 200);
  await repo.withStore(false, async store => { assert.equal(store.runs()[0].state, 'complete'); });
});

test('three cloud deadlines mark the stalled task failed and allow later queue work to finish', async () => {
  const repo = new SnapshotRepository(new TransactionPool());
  let slowId = 0; let laterId = 0;
  await repo.withStore(true, async store => {
    slowId = store.createRun('kopis', 'andong', '2026-10-01', '2026-10-31');
    laterId = store.createRun('kopis', 'gongju', '2026-10-01', '2026-10-31');
    store.setRunState(laterId, 'paused');
  });
  const provider: Provider = { source: 'kopis', detail: async item => item, list: async (input, signal) => {
    if (input.city.id === 'gongju') return { items: [], hasMore: false };
    return new Promise((_resolve, reject) => { signal?.addEventListener('abort', () => reject(new Error('deadline')), { once: true }); });
  } };
  for (let attempt = 1; attempt <= 3; attempt++) {
    await repo.withStore(true, async store => { store.db.prepare("UPDATE sync_tasks SET available_at='2000-01-01T00:00:00.000Z' WHERE run_id=?").run(slowId); });
    // Allow the cross-request 350ms API cooldown while retaining the 30ms task deadline.
    const response = await handleCloudRequest(request('/api/cloud/tick', 'POST', {}), { env, repository: repo, providers: { kopis: provider }, tickStepMs: 30, tickBudgetMs: 800 });
    assert.equal(response.status, 200);
    await repo.withStore(false, async store => {
      const task = store.db.prepare('SELECT attempts,state,error FROM sync_tasks WHERE run_id=?').get(slowId)!;
      assert.equal(task.attempts, attempt);
      assert.equal(task.state, attempt === 3 ? 'failed' : 'queued');
      assert.match(String(task.error), /응답 시간이 초과/);
    });
  }
  await repo.withStore(true, async store => {
    assert.equal(store.runs().find(run => run.id === slowId)!.state, 'partial');
    store.setRunState(laterId, 'queued');
  });
  const response = await handleCloudRequest(request('/api/cloud/tick', 'POST', {}), { env, repository: repo, providers: { kopis: provider } });
  assert.equal(response.status, 200);
  await repo.withStore(false, async store => {
    assert.equal(store.runs().find(run => run.id === laterId)!.state, 'complete');
    assert.equal(store.runs().find(run => run.id === slowId)!.state, 'partial');
  });
});

test('public cloud database failures return safe errors', async () => {
  const unavailable = { withStore: async () => { throw new Error('postgres://secret-password@private-host'); } };
  const response = await handleCloudRequest(request('/api/bootstrap'), { env, repository: unavailable,readonlyFallback:{load:async()=>undefined} });
  assert.equal(response.status, 503); assert.ok(!(await response.text()).includes('secret'));
  assert.equal(response.headers.get('retry-after'), '60');
});

test('snapshot capacity rejection preserves prior data and returns a non-retryable storage explanation', async () => {
  const pool = new TransactionPool(); const repo = new SnapshotRepository(pool);
  await repo.withStore(true, async store => { store.addCity({ ...DEFAULT_CITIES[0], id: 'test-capacity-preserved' }); });
  const before = Buffer.from(pool.bytes!);
  await assert.rejects(repo.withStore(true, async store => {
    store.db.exec('CREATE TABLE test_capacity(data BLOB)');
    store.db.prepare('INSERT INTO test_capacity VALUES(randomblob(?))').run(MAX_SNAPSHOT_BYTES);
  }), (error: unknown) => error instanceof SnapshotCapacityError && error.code === 'SNAPSHOT_CAPACITY');
  assert.deepEqual(pool.bytes, before); assert.equal(pool.writes, 1);
  await assert.rejects(repo.seedIfEmpty(Buffer.alloc(MAX_DATABASE_BYTES + 1)), SnapshotCapacityError);
  const failing = { withStore: async () => { throw new SnapshotCapacityError(); } };
  const response = await handleCloudRequest(request('/api/cloud/tick', 'POST', {}), { env, repository: failing });
  assert.equal(response.status, 507); assert.equal(response.headers.has('retry-after'), false);
  const body = await response.json(); assert.equal(body.code, 'SNAPSHOT_CAPACITY'); assert.match(body.error, /기존 자료는 유지됩니다/);
  await repo.withStore(false, async store => { assert.ok(store.cities().some(city => city.id === 'test-capacity-preserved')); });
});

test('compressed snapshots retain complete large datasets and transparently read legacy SQLite bytes',async()=>{
  const large=Buffer.alloc(MAX_SNAPSHOT_BYTES+1024,65);Buffer.from('SQLite format 3\0').copy(large);
  const encoded=encodeSnapshot(large);
  assert.ok(encoded.length<MAX_SNAPSHOT_BYTES);
  assert.deepEqual(decodeSnapshot(encoded),large);
  const pool=new TransactionPool(),repo=new SnapshotRepository(pool);
  await repo.withStore(true,async store=>{store.addCity({...DEFAULT_CITIES[0],id:'test-legacy'});});
  const legacy=decodeSnapshot(pool.bytes!);pool.bytes=legacy;
  await repo.withStore(false,async store=>{assert.ok(store.cities().find(city=>city.id==='test-legacy'));});
  await repo.withStore(true,async store=>{store.addCity({...DEFAULT_CITIES[0],id:'test-compressed'});});
  assert.equal(pool.bytes![0],0x1f);assert.equal(pool.bytes![1],0x8b);
  await repo.withStore(false,async store=>{assert.ok(store.cities().find(city=>city.id==='test-compressed'));});
});

const cloudPerformance = (id: number, changes: Partial<PerformanceInput> = {}): PerformanceInput => ({
  source: 'kopis', sourceId: `TEST_CLOUD_${id}`, title: `TEST 공연 ${id}`, cityId: 'andong',
  startDate: '2026-10-01', endDate: '2026-10-31', genre: '음악', sourceGenre: 'TEST 음악',
  venue: 'TEST 공연장', address: '', poster: '', sourceUrl: '', price: '', priceType: 'unknown', age: '', runtime: '',
  cast: '', producer: '', organizer: '', contact: '', schedule: '', description: '', status: '',
  detailState: 'complete', classification: 'performance', reviewReason: '', raw: null, ...changes,
});
function memoryRepository(store: Store) {
  return { withStore: async <T>(_write: boolean, operation: (store: Store) => Promise<T>) => operation(store) };
}

test('public JSON and Excel omit prior personal data while keeping it intact in storage', async () => {
  const store=new Store(':memory:',DEFAULT_CITIES);
  try{
    const id=store.upsert(cloudPerformance(200));const note='TEST_PRIVATE_NOTE_MUST_NOT_LEAK';store.bookmark(id,true,note);
    const options={env,repository:memoryRepository(store),providers:{}};
    for(const route of ['/api/bootstrap','/api/performances','/api/map',`/api/performances/${id}`]){
      const response=await handleCloudRequest(request(route),options);assert.equal(response.status,200);
      const text=await response.text();assert.ok(!text.includes(note));assert.ok(!text.includes('"bookmarked":true'));
      if(route==='/api/bootstrap')assert.equal(JSON.parse(text).bookmarkCount,0);
    }
    const exported=await handleCloudRequest(request('/api/export.xlsx'),options);assert.equal(exported.status,200);
    const workbook=new ExcelJS.Workbook();await workbook.xlsx.load(Buffer.from(await exported.arrayBuffer()) as any);
    const contents=JSON.stringify(workbook.model);assert.ok(!contents.includes(note));assert.ok(!contents.includes('기획 메모'));
    assert.equal(workbook.getWorksheet('공연 목록')!.columnCount,18);
    for(const route of ['/api/performances','/api/map','/api/export.xlsx']){
      for(const value of ['true','false'])assert.equal((await handleCloudRequest(request(`${route}?bookmarked=${value}`),options)).status,400);
    }
    assert.equal((await handleCloudRequest(request('/api/details','POST',{filters:{bookmarked:'true'}}),options)).status,400);
    for(const [route,method] of [[`/api/performances/${id}/bookmark`,'PUT'],['/api/backup','POST'],['/api/cloud/backup','GET'],['/api/cities','POST'],['/api/config/reload','POST'],['/api/shutdown','POST']]){
      const response=await handleCloudRequest(request(route,method,method==='GET'?undefined:{}),options);assert.equal(response.status,404);
    }
    assert.equal(store.item(id)!.note,note);assert.equal(store.item(id)!.bookmarked,true);assert.equal(store.counts().bookmarks,1);
  }finally{store.close();}
});

test('public collection controls work without cookies but still require same-origin JSON requests', async () => {
  const store=new Store(':memory:',DEFAULT_CITIES);
  try{
    const id=store.upsert(cloudPerformance(201,{detailState:'pending'}));let calls=0;
    const provider:Provider={source:'kopis',list:async()=>{calls++;return{items:[],hasMore:false};},detail:async item=>{calls++;return{...item,detailState:'complete'};}};
    const options={env,repository:memoryRepository(store),providers:{kopis:provider}};
    const rejected=await handleCloudRequest(request('/api/sync','POST',{},{origin:'https://evil.test'}),options);assert.equal(rejected.status,403);
    assert.equal((await handleCloudRequest(new Request('https://culture.test/api/sync',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}),options)).status,403);
    assert.equal((await handleCloudRequest(new Request('https://culture.test/api/sync',{method:'POST',headers:{'x-culture-request':'1','content-type':'text/plain'},body:'{}'}),options)).status,415);
    const queued=await handleCloudRequest(request('/api/sync','POST',{cities:['andong'],sources:['kopis'],from:'2026-10-01',to:'2026-10-31'}),options);assert.equal(queued.status,200);
    const run=(await queued.json()).runs[0];
    assert.equal((await handleCloudRequest(request(`/api/sync/${run.id}/pause`,'POST',{}),options)).status,200);
    assert.equal(store.runs().find(item=>item.id===run.id)!.state,'paused');
    assert.equal((await handleCloudRequest(request(`/api/sync/${run.id}/resume`,'POST',{}),options)).status,200);
    assert.equal((await handleCloudRequest(request(`/api/performances/${id}/detail`,'POST',{}),options)).status,200);
    assert.equal((await handleCloudRequest(request('/api/details','POST',{filters:{}}),options)).status,200);
    const tick=await handleCloudRequest(request('/api/cloud/tick','POST',{}),options);assert.equal(tick.status,200);assert.equal((await tick.json()).active,false);
    assert.equal(calls,2);assert.equal(store.item(id)!.detailState,'complete');
  }finally{store.close();}
});

test('local search mode omits notes from Excel while explicitly permitted launcher shutdown still works', async () => {
  const store=new Store(':memory:',DEFAULT_CITIES);
  const id=store.upsert(cloudPerformance(202));const note='TEST_LOCAL_OLD_NOTE';store.bookmark(id,true,note);
  let stopped=false;let finishShutdown!:()=>void;const shutdownDone=new Promise<void>(resolve=>{finishShutdown=resolve;});
  const {app}=await createApp({port:4317,databasePath:':memory:',keys:{kopis:'',culture:''},requestIntervalMs:350,syncIntervalHours:24},{store,providers:{},startWorker:false,serveStatic:false,searchOnly:true,allowLocalManagement:true,shutdown:()=>{stopped=true;finishShutdown();}});
  try{
    const exported=await app.inject('/api/export.xlsx');assert.equal(exported.statusCode,200);
    const workbook=new ExcelJS.Workbook();await workbook.xlsx.load(exported.rawPayload as any);
    assert.ok(!JSON.stringify(workbook.model).includes(note));assert.equal(workbook.getWorksheet('공연 목록')!.columnCount,18);
    const headers={'x-culture-request':'1','content-type':'application/json'};
    const blocked=await app.inject({method:'PUT',url:`/api/performances/${id}/bookmark`,headers,payload:{bookmarked:false}});assert.equal(blocked.statusCode,404);
    const response=await app.inject({method:'POST',url:'/api/shutdown',headers,payload:{}});assert.equal(response.statusCode,200);
    await shutdownDone;assert.equal(stopped,true);assert.equal(store.item(id)!.note,note);
  }finally{await app.close();store.close();}
});

test('oversized UTF-8 JSON responses return a filter guidance error before the platform limit', async () => {
  const store = new Store(':memory:', DEFAULT_CITIES);
  try {
    const id = store.upsert(cloudPerformance(1, { description: '가'.repeat(Math.ceil(MAX_API_RESPONSE_BYTES / 3) + 1) }));
    const options = { env, repository: memoryRepository(store), providers: {} };
    for (const route of ['/api/performances', `/api/performances/${id}`]) {
      const response = await handleCloudRequest(request(route), options);
      assert.equal(response.status, 413);
      const body = await response.json(); assert.equal(body.code, 'RESPONSE_CAPACITY'); assert.match(body.error, /조회 조건을 좁혀/);
    }
    assert.ok(store.item(id)!.description.length > 1000000);
    const map = await handleCloudRequest(request('/api/map'), options);
    assert.equal(map.status, 200); assert.equal((await map.json()).total, 1);
  } finally { store.close(); }
});

test('oversized real Excel exports return JSON filter guidance instead of a platform failure', async () => {
  const store = new Store(':memory:', DEFAULT_CITIES);
  try {
    // Unique, incompressible strings stay within Excel's cell text limit while making the ZIP exceed 4 MiB.
    store.transaction(() => { for (let index = 0; index < 200; index++) store.upsert(cloudPerformance(index, { title: randomBytes(24000).toString('base64') })); });
    const response = await handleCloudRequest(request('/api/export.xlsx'), { env, repository: memoryRepository(store), providers: {} });
    assert.equal(response.status, 413); assert.match(response.headers.get('content-type')!, /application\/json/);
    assert.equal(response.headers.has('content-disposition'), false);
    const body = await response.json(); assert.equal(body.code, 'RESPONSE_CAPACITY'); assert.match(body.error, /지역·기간/);
    assert.equal(store.search({}).total, 200);
  } finally { store.close(); }
});

test('cloud queue activity includes older runs outside the visible recent-history window', async () => {
  const repo = new SnapshotRepository(new TransactionPool());
  let first = 0; let second = 0;
  await repo.withStore(true, async store => {
    first = store.createRun('kopis', 'andong', '2026-10-01', '2026-10-31');
    second = store.createRun('kopis', 'gongju', '2026-10-01', '2026-10-31');
    for (let index = 0; index < 201; index++) store.recomputeRun(store.createRun('kopis', 'andong', '2026-10-01', '2026-10-31', true));
  });
  let calls = 0;
  const provider: Provider = { source: 'kopis', list: async () => { calls++; return { items: [], hasMore: false }; }, detail: async item => item };
  const response = await handleCloudRequest(request('/api/cloud/tick', 'POST', {}), { env, repository: repo, providers: { kopis: provider } });
  assert.equal(response.status, 200); assert.equal(calls, 2); assert.equal((await response.json()).active, false);
  await repo.withStore(false, async store => { assert.ok(store.runs(1000).filter(run => run.id === first || run.id === second).every(run => run.state === 'complete')); });
});

test('scheduled refresh status is public, but a status outage does not hide search data', async () => {
  const repo = new SnapshotRepository(new TransactionPool());
  const automatic={status:'complete' as const,day:'2026-10-16',from:'2026-10-01',to:'2027-01-16',
    lastSuccessAt:'2026-10-16T08:53:00.000Z',updatedAt:'2026-10-16T08:53:00.000Z',counts:null,error:null,
    schedule:{timezone:'Asia/Seoul' as const,primary:'04:17',retries:['06:47','12:47','20:47']}};
  const options={env:{...env,AUTOMATIC_REFRESH_ENABLED:'1'},repository:repo,providers:{},refreshStatus:async()=>automatic};
  const response=await handleCloudRequest(request('/api/bootstrap'),options);
  assert.equal(response.status,200);
  const boot=await response.json();assert.equal(boot.automaticRefresh.enabled,true);
  assert.equal(boot.automaticRefresh.lastSuccessAt,automatic.lastSuccessAt);assert.equal(boot.runtime.backgroundSync,true);
  assert.ok(!JSON.stringify(boot).includes(env.KOPIS_API_KEY));
  const unavailable=await handleCloudRequest(request('/api/bootstrap'),{...options,refreshStatus:async()=>{throw new Error('TEST_SECRET_DATABASE_URL');}});
  const failed=await unavailable.json();assert.equal(unavailable.status,200);assert.equal(failed.automaticRefresh.status,'unavailable');
  assert.ok(!JSON.stringify(failed).includes('TEST_SECRET_DATABASE_URL'));
});

test('durable scheduling disables legacy browser refresh while preserving explicit collection work', async () => {
  const store=new Store(':memory:',DEFAULT_CITIES);
  try {
    const old=store.createRun('kopis','andong','2026-10-01','2026-10-31');
    store.db.prepare("UPDATE sync_tasks SET state='done' WHERE run_id=?").run(old);store.recomputeRun(old);
    store.db.prepare("UPDATE sync_runs SET updated_at='2020-01-01T00:00:00Z' WHERE id=?").run(old);
    let calls=0;
    const provider:Provider={source:'kopis',list:async()=>{calls++;return{items:[],hasMore:false};},detail:async item=>item};
    const options={env:{...env,AUTOMATIC_REFRESH_ENABLED:'1'},repository:memoryRepository(store),providers:{kopis:provider}};
    const idle=await handleCloudRequest(request('/api/cloud/tick','POST',{}),options);
    assert.equal(idle.status,200);assert.equal(calls,0);assert.equal(store.runs().length,1);
    store.createRun('kopis','gongju','2026-10-01','2026-10-31');
    const manual=await handleCloudRequest(request('/api/cloud/tick','POST',{}),options);
    assert.equal(manual.status,200);assert.equal(calls,1);assert.ok(store.runs().every(run=>run.state==='complete'));
  } finally {store.close();}
});
