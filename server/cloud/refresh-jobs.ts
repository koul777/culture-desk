import { Pool } from 'pg';
import { DatabaseSync } from 'node:sqlite';
import { encodeSnapshot, type SnapshotPool } from './snapshot.js';
import { NATIONAL_CITIES } from '../providers/cities.js';
import { dateChunks, isDate } from '../dates.js';
import type { PublicRefreshStatus } from '../../shared/types.js';
export type { PublicRefreshStatus } from '../../shared/types.js';

export const REFRESH_SCHEDULE: PublicRefreshStatus['schedule'] = { timezone: 'Asia/Seoul', primary: '04:17', retries: ['06:47', '12:47', '20:47'] };
export const LEASE_SECONDS = 120;
export interface RefreshWindow { day: string; from: string; to: string }
export interface RefreshCounts { expectedRuns: number; completeRuns: number; totalTasks: number; doneTasks: number; remaining: number; performances: number }
export type RefreshStatus = 'idle' | 'running' | 'retry_wait' | 'failed' | 'complete';
export interface RefreshJob extends RefreshWindow { checkpoint: Buffer | null; counts: RefreshCounts | null }
export class LeaseLostError extends Error { constructor() { super('Refresh lease lost'); this.name = 'LeaseLostError'; } }
export function refreshWindow(now = new Date()): RefreshWindow {
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const [year, month, date] = day.split('-').map(Number);
  const lastDay = new Date(Date.UTC(year, month + 3, 0)).getUTCDate();
  const to = new Date(Date.UTC(year, month - 1 + 3, Math.min(date, lastDay))).toISOString().slice(0, 10);
  return { day, from: day.slice(0, 7) + '-01', to };
}
function validateWindow(window: RefreshWindow) {
  if (![window.day, window.from, window.to].every(isDate) || window.from > window.to) throw new Error('Invalid refresh date range');
}
export function safeRefreshError(error: unknown): string {
  const kind = (error as { kind?: string; name?: string })?.kind;
  if (kind === 'auth') return 'API 인증을 확인해야 합니다. 다음 예약에서 다시 확인합니다.';
  if (kind === 'quota') return 'API 호출 한도에 도달했습니다. 다음 예약에서 남은 작업을 재시도합니다.';
  if (error instanceof LeaseLostError) return '다른 실행이 작업을 이어받았습니다.';
  return '자동 갱신이 중단되었습니다. 저장한 지점부터 다음 예약에서 재시도합니다.';
}
/** Audit actual task evidence, not just the collector's exit code or reported totals. */
export function auditRefreshCheckpoint(db: DatabaseSync, window: RefreshWindow): { complete: boolean; counts: RefreshCounts } {
  validateWindow(window);
  if (Object.values(db.prepare('PRAGMA quick_check').get() || {})[0] !== 'ok') throw new Error('Invalid checkpoint database');
  const chunks = dateChunks(window.from, window.to);
  let completeRuns = 0, totalTasks = 0, doneTasks = 0;
  for (const city of NATIONAL_CITIES) for (const source of ['kopis', 'culture']) {
    const runs = db.prepare('SELECT id,state FROM sync_runs WHERE source=? AND city_id=? AND from_date=? AND to_date=? AND detail_only=0').all(source, city.id, window.from, window.to);
    if (runs.length !== 1) continue;
    const run = runs[0];
    const tasks = db.prepare('SELECT kind,from_date,to_date,page,state FROM sync_tasks WHERE run_id=?').all(run.id);
    totalTasks += tasks.length; doneTasks += tasks.filter(task => task.state === 'done').length;
    const hasChunks = chunks.every(chunk => tasks.some(task => task.kind === 'list' && task.from_date === chunk.from && task.to_date === chunk.to && Number(task.page) === 1));
    if (run.state === 'complete' && hasChunks && tasks.every(task => task.state === 'done')) completeRuns++;
  }
  const expectedRuns = NATIONAL_CITIES.length * 2;
  const counts = { expectedRuns, completeRuns, totalTasks, doneTasks,
    remaining: Math.max(totalTasks - doneTasks, expectedRuns - completeRuns),
    performances: Number(db.prepare("SELECT COUNT(*) n FROM performances WHERE classification='performance'").get()?.n || 0) };
  return { complete: completeRuns === expectedRuns && counts.remaining === 0, counts };
}
const SCHEMA = `CREATE TABLE IF NOT EXISTS culture_refresh_job (
  day DATE PRIMARY KEY, from_date DATE NOT NULL, to_date DATE NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('running','retry_wait','failed','complete')),
  checkpoint BYTEA, counts JSONB, lease_owner TEXT, lease_until TIMESTAMPTZ,
  last_success TIMESTAMPTZ, last_error TEXT, updated_at TIMESTAMPTZ NOT NULL DEFAULT now());`;
const iso = (value: unknown): string | null => value ? new Date(value as string).toISOString() : null;
const dateOnly = (value: unknown): string => typeof value === 'string' ? value.slice(0, 10) : new Date(value as string).toISOString().slice(0, 10);
export class RefreshJobRepository {
  private ready?: Promise<void>;
  constructor(private readonly pool: SnapshotPool) {}
  async initialize() {
    if (!this.ready) this.ready = this.withClient(async client => { await client.query(SCHEMA); }).catch(error => { this.ready = undefined; throw error; });
    return this.ready;
  }
  private async withClient<T>(fn: (client: Awaited<ReturnType<SnapshotPool['connect']>>) => Promise<T>): Promise<T> {
    const client = await this.pool.connect(); try { return await fn(client); } finally { client.release(); }
  }
  async acquire(window: RefreshWindow, owner: string): Promise<{ state: 'acquired'; job: RefreshJob } | { state: 'busy' | 'complete' }> {
    validateWindow(window); await this.initialize();
    return this.withClient(async client => {
      await client.query('BEGIN');
      try {
        // Serialize selection across dates, so midnight cannot create two active collectors.
        await client.query('SELECT pg_advisory_xact_lock(73490821)');
        // A collector that crossed midnight still owns its lease; never run two days concurrently.
        if ((await client.query("SELECT day FROM culture_refresh_job WHERE status='running' AND lease_until>now() LIMIT 1")).rows.length) {
          await client.query('COMMIT'); return { state: 'busy' };
        }
        // An unrecoverable old provider record must not starve every subsequent day's refresh.
        await client.query(`UPDATE culture_refresh_job SET status='failed',lease_owner=NULL,lease_until=NULL,
          last_error='이전 날짜의 미완료 작업입니다. 새 날짜의 전국 갱신에서 다시 확인합니다.',updated_at=now()
          WHERE day<$1 AND status NOT IN ('complete','failed')`, [window.day]);
        await client.query("UPDATE culture_refresh_job SET checkpoint=NULL WHERE (status='complete' OR day<($1::date-7)) AND checkpoint IS NOT NULL", [window.day]);
        await client.query("INSERT INTO culture_refresh_job(day,from_date,to_date,status) VALUES($1,$2,$3,'retry_wait') ON CONFLICT DO NOTHING", [window.day, window.from, window.to]);
        let row = (await client.query('SELECT *,day::text AS day,from_date::text AS from_date,to_date::text AS to_date FROM culture_refresh_job WHERE day=$1 FOR UPDATE', [window.day])).rows[0];
        if (row.status === 'complete') { await client.query('COMMIT'); return { state: 'complete' }; }
        const result = await client.query(`UPDATE culture_refresh_job SET status='running',lease_owner=$2,
          lease_until=now()+interval '120 seconds',updated_at=now(),last_error=NULL
          WHERE day=$1 AND (lease_until IS NULL OR lease_until<=now()) RETURNING *,day::text AS day,from_date::text AS from_date,to_date::text AS to_date`, [dateOnly(row.day), owner]);
        await client.query('COMMIT');
        if (!result.rowCount) return { state: 'busy' };
        row = result.rows[0];
        return { state: 'acquired', job: { day: dateOnly(row.day), from: dateOnly(row.from_date), to: dateOnly(row.to_date), checkpoint: row.checkpoint, counts: row.counts } };
      } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    });
  }
  async heartbeat(day: string, owner: string) {
    const result = await this.withClient(client => client.query("UPDATE culture_refresh_job SET lease_until=now()+interval '120 seconds',updated_at=now() WHERE day=$1 AND lease_owner=$2 AND lease_until>now() AND status='running'", [day, owner]));
    if (result.rowCount !== 1) throw new LeaseLostError();
  }
  async save(day: string, owner: string, database: Buffer, counts: RefreshCounts) {
    const encoded = encodeSnapshot(database);
    const result = await this.withClient(client => client.query('UPDATE culture_refresh_job SET checkpoint=$3,counts=$4,updated_at=now() WHERE day=$1 AND lease_owner=$2 AND lease_until>now() AND status=\'running\'', [day, owner, encoded, JSON.stringify(counts)]));
    if (result.rowCount !== 1) throw new LeaseLostError();
  }
  async finish(day: string, owner: string, complete: boolean, error?: unknown) {
    const result = await this.withClient(client => client.query(`UPDATE culture_refresh_job SET status=$3,
      last_success=CASE WHEN $3='complete' THEN now() ELSE last_success END,last_error=$4,
      checkpoint=CASE WHEN $3='complete' THEN NULL ELSE checkpoint END,
      lease_owner=NULL,lease_until=NULL,updated_at=now() WHERE day=$1 AND lease_owner=$2 AND lease_until>now() AND status='running'`,
    [day, owner, complete ? 'complete' : 'retry_wait', complete ? null : safeRefreshError(error)]));
    if (result.rowCount !== 1) throw new LeaseLostError();
  }
  async seed(window: RefreshWindow, _database: Buffer, counts: RefreshCounts): Promise<boolean> {
    validateWindow(window); await this.initialize();
    const result = await this.withClient(client => client.query(`INSERT INTO culture_refresh_job(day,from_date,to_date,status,counts,last_success)
      VALUES($1,$2,$3,'complete',$4,now()) ON CONFLICT DO NOTHING`, [window.day, window.from, window.to, JSON.stringify(counts)]));
    return result.rowCount === 1;
  }
  async probe(): Promise<void> {
    await this.initialize();
    await this.withClient(async client => {
      await client.query('BEGIN');
      try {
        await client.query("INSERT INTO culture_refresh_job(day,from_date,to_date,status,lease_owner,lease_until) VALUES('9999-12-31','9999-12-01','9999-12-31','running','probe',now()+interval '120 seconds') ON CONFLICT DO NOTHING");
        const result = await client.query("UPDATE culture_refresh_job SET status='complete',last_success=now() WHERE day='9999-12-31' AND lease_owner='probe' AND lease_until>now() RETURNING status");
        if (result.rows[0]?.status !== 'complete') throw new Error('Refresh probe failed');
      } finally { await client.query('ROLLBACK'); }
    });
  }
  async publicStatus(): Promise<PublicRefreshStatus> {
    await this.initialize();
    return this.withClient(async client => {
      const row = (await client.query(`SELECT day::text AS day,from_date::text AS from_date,to_date::text AS to_date,status,counts,lease_until,updated_at,last_error,
        (SELECT MAX(last_success) FROM culture_refresh_job) last_success FROM culture_refresh_job
        ORDER BY day DESC LIMIT 1`)).rows[0];
      return { status: row ? row.status === 'running' && (!row.lease_until || new Date(row.lease_until).getTime() <= Date.now()) ? 'retry_wait' : row.status : 'idle',
        day: row ? dateOnly(row.day) : null, from: row ? dateOnly(row.from_date) : null, to: row ? dateOnly(row.to_date) : null,
        counts: row?.counts || null, lastSuccessAt: iso(row?.last_success), updatedAt: iso(row?.updated_at),
        error: row?.last_error || null, schedule: REFRESH_SCHEDULE };
    });
  }
}
let repository: RefreshJobRepository | undefined;
export function getRefreshJobRepository(): RefreshJobRepository {
  if (!repository) {
    const connectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL;
    if (!connectionString) throw new Error('Cloud database is not configured');
    const pool = new Pool({ connectionString, max: 3, connectionTimeoutMillis: 10000, idleTimeoutMillis: 10000, statement_timeout: 30000, allowExitOnIdle: true });
    pool.on('error', () => {}); repository = new RefreshJobRepository(pool);
  }
  return repository;
}
