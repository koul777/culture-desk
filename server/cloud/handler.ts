import type { Provider, PublicRefreshStatus, Source } from '../../shared/types.js';
import type { Config } from '../config.js';
import { createApp, isSearchRoute } from '../app.js';
import type { Store, Task } from '../store.js';
import { Worker } from '../worker.js';
import { getSnapshotRepository, SnapshotCapacityError, type SnapshotRepository } from './snapshot.js';
import { equalSecret, validMutationOrigin } from './auth.js';
import { getRefreshJobRepository } from './refresh-jobs.js';

type Repository = Pick<SnapshotRepository, 'withStore'>;
export interface CloudOptions {
  env?: NodeJS.ProcessEnv;
  repository?: Repository;
  providers?: Partial<Record<Source, Provider>>;
  tickBudgetMs?: number;
  tickStepMs?: number;
  refreshStatus?: () => Promise<PublicRefreshStatus>;
}
const headers = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin' };
export const MAX_API_RESPONSE_BYTES = 4 * 1024 * 1024;
const capacityMessage = '조회 결과가 다운로드 한도를 초과했습니다. 지역·기간 등 조회 조건을 좁혀 다시 시도하세요.';
function json(body: unknown, status = 200, extra: Record<string,string> = {}): Response {
  const serialized = JSON.stringify(body);
  if (Buffer.byteLength(serialized) > MAX_API_RESPONSE_BYTES) return responseCapacity();
  return new Response(serialized, { status, headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8', ...extra } });
}
function responseCapacity(): Response { return json({ code: 'RESPONSE_CAPACITY', error: capacityMessage }, 413); }
async function automaticRefreshStatus(options: CloudOptions): Promise<PublicRefreshStatus & {enabled:true}> {
  try {
    return { ...(await (options.refreshStatus ? options.refreshStatus() : getRefreshJobRepository().publicStatus())), enabled:true };
  } catch {
    return {enabled:true,status:'unavailable',day:null,from:null,to:null,lastSuccessAt:null,updatedAt:null,counts:null,
      error:'자동 갱신 상태를 확인하지 못했습니다. 잠시 후 다시 확인하세요.',
      schedule:{timezone:'Asia/Seoul',primary:'04:17',retries:['06:47','12:47','20:47']}};
  }
}
function cloudConfig(store: Store, env: NodeJS.ProcessEnv): Config {
  return { port: 4317, databasePath: store.filename, keys: { kopis: (env.KOPIS_API_KEY || '').trim(), culture: (env.CULTURE_API_KEY || '').trim() }, requestIntervalMs: 350, syncIntervalHours: 24 };
}
async function payload(request: Request): Promise<string | Response> {
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return json({ error: 'JSON 형식으로 요청하세요.' }, 415);
  if (Number(request.headers.get('content-length')) > 256 * 1024) return json({ error: '요청이 너무 큽니다.' }, 413);
  const body = await request.text();
  if (Buffer.byteLength(body) > 256 * 1024) return json({ error: '요청이 너무 큽니다.' }, 413);
  try { JSON.parse(body); return body; } catch { return json({ error: '요청 내용을 확인하세요.' }, 400); }
}
export async function handleCloudRequest(request: Request, options: CloudOptions = {}): Promise<Response> {
  const env = options.env || process.env;
  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  const route = url.pathname.replace(/\/$/, '');
  if (route === '/api/health' && method === 'GET') return json({ ok: true, app: 'culture-desk', deployment: 'cloud' });
  const cron = route === '/api/cloud/cron';
  if (cron) {
    if (method !== 'GET' || !equalSecret(request.headers.get('authorization') || '', env.CRON_SECRET ? `Bearer ${env.CRON_SECRET}` : '')) return json({ error: '인증이 필요합니다.' }, 401);
  }
  if(!cron&&!isSearchRoute(method,route)&&!(route==='/api/cloud/tick'&&method==='POST'))return json({error:'요청을 찾을 수 없습니다.'},404);
  let body: string | undefined;
  if (!['GET','HEAD','OPTIONS'].includes(method)) {
    if (!validMutationOrigin(request)) return json({ error: '허용되지 않은 요청입니다.' }, 403);
    const parsed = await payload(request); if (parsed instanceof Response) return parsed; body = parsed;
  }
  try {
    const repo = options.repository || getSnapshotRepository();
    if (cron && env.AUTOMATIC_REFRESH_ENABLED === '1') return json({ok:true,automaticRefresh:await automaticRefreshStatus(options)});
    if ((route === '/api/cloud/tick' && method === 'POST') || cron) return json(await runCloudTicks(repo, env, options));
    const write = !['GET','HEAD'].includes(method);
    const result = await repo.withStore(write, async store => {
      const config = cloudConfig(store, env);
      const runtime = await createApp(config, { store, providers: options.providers, startWorker: false, serveStatic: false, searchOnly:true, configLoader: () => config });
      try {
        // The public wrapper validates Origin and allowed routes. The local adapter still enforces its own host/JSON rules.
        const injected = await runtime.app.inject({ method: method as any, url: url.pathname + url.search,
          headers: { host: 'localhost:4317', 'x-culture-request': '1', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, payload: body });
        if (injected.statusCode >= 500) throw new Error('Local request failed');
        if (injected.rawPayload.byteLength > MAX_API_RESPONSE_BYTES) return responseCapacity();
        if (route === '/api/bootstrap' && injected.statusCode === 200) {
          const bootstrap = injected.json(); bootstrap.deployment = 'cloud';
          bootstrap.runtime = { mode: 'cloud', backgroundSync: env.AUTOMATIC_REFRESH_ENABLED === '1' };
          if(env.AUTOMATIC_REFRESH_ENABLED === '1')bootstrap.automaticRefresh=await automaticRefreshStatus(options);
          return json(bootstrap);
        }
        const responseHeaders = new Headers(headers);
        for (const name of ['content-type','content-disposition']) if (injected.headers[name]) responseHeaders.set(name, String(injected.headers[name]));
        return new Response(method === 'HEAD' ? null : new Uint8Array(injected.rawPayload), { status: injected.statusCode, headers: responseHeaders });
      } finally { await runtime.app.close(); }
    });
    return result;
  } catch (error) {
    if (error instanceof SnapshotCapacityError) return json({ code: 'SNAPSHOT_CAPACITY', error: '저장 공간 한도에 도달했습니다. 수집 범위를 줄이거나 저장소를 확장하세요. 기존 자료는 유지됩니다.' }, 507);
    // Never return database URLs, API request URLs, keys, stack traces, or provider payloads.
    // Log only an error identifier and code locations; messages can contain credentials.
    const failure=error as {name?:string;code?:string;stack?:string};
    console.error(JSON.stringify({event:'culture_cloud_failure',
      type:/^[A-Za-z]+$/.test(failure.name||'')?failure.name:'Error',
      code:/^[A-Z_0-9]+$/.test(failure.code||'')?failure.code:undefined,
      locations:failure.stack?.split('\n').filter(line=>/^\s+at /.test(line)).slice(0,4).map(line=>line.replace(/https?:\/\/\S+/g,'[url]'))}));
    return json({ error: '클라우드 연결을 처리하지 못했습니다. 잠시 후 다시 시도하세요.' }, 503, { 'Retry-After': '3' });
  }
}
async function runCloudTicks(repo: Repository, env: NodeJS.ProcessEnv, options: CloudOptions) {
  const deadline = Date.now() + (options.tickBudgetMs ?? 35000);
  const stepMs = options.tickStepMs ?? 12000;
  let steps = 0; let active = true;
  while (steps < 20 && Date.now() + stepMs < deadline && active) {
    active = await repo.withStore(true, async store => {
      const worker = new Worker(store, cloudConfig(store, env), options.providers);
      // The durable scheduled runner owns daily nationwide refreshes; browser ticks only advance explicit user requests.
      if(env.AUTOMATIC_REFRESH_ENABLED === '1')worker.refreshDue=()=>{};
      let timedOutTask: Task | undefined;
      const timer = setTimeout(() => {
        // Local shutdown restores an interrupted task without consuming an attempt.
        // A repeated cloud deadline is a real retryable failure and must not monopolize the queue.
        timedOutTask = store.db.prepare("SELECT * FROM sync_tasks WHERE state='running' ORDER BY id LIMIT 1").get() as Task | undefined;
        void worker.stop();
      }, stepMs); timer.unref();
      try {
        await worker.tick();
        if (timedOutTask) {
          const task = timedOutTask;
          store.transaction(() => {
            store.db.prepare('UPDATE sync_tasks SET attempts=? WHERE id=?').run(task.attempts, task.id);
            store.failTask(task, '클라우드 수집 응답 시간이 초과됐습니다. 재시도 후에도 실패하면 해당 작업을 재개하세요.', 'network');
            if (task.kind === 'detail' && task.attempts >= 3) {
              const item = store.internal(task.source, task.source_id);
              if (item && item.detailState !== 'complete') store.upsert({ ...item, detailState: 'failed' });
            }
          });
        }
        return !!store.db.prepare("SELECT 1 FROM sync_runs WHERE state IN ('queued','running') LIMIT 1").get();
      } finally { clearTimeout(timer); await worker.stop(); }
    });
    steps++;
    if (active && Date.now() + stepMs + 350 < deadline) await new Promise(resolve => setTimeout(resolve, 350));
  }
  return { ok: true, steps, active, continueWhileOpen: true };
}
