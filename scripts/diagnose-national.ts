import { DatabaseSync } from 'node:sqlite';
import { readConfig } from '../server/config.js';
import { createProviders } from '../server/providers/index.js';
import { NATIONAL_CITIES } from '../server/providers/cities.js';
import type { Source } from '../shared/types.js';
import { readNationalBatch } from './national-config.js';

// One read-only retry for an explicitly selected staging task; no response data or keys are logged.
const taskId = Number(process.argv[2]);
if (!Number.isSafeInteger(taskId) || taskId <= 0) throw new Error('Provide a staging task ID');
const db = new DatabaseSync(readNationalBatch().filename, { readOnly: true });
try {
  const task = db.prepare('SELECT * FROM sync_tasks WHERE id=?').get(taskId)!;
  const keys = readConfig().keys;
  const providers = createProviders(keys, { fetch: async (url, init) => {
    const response = await fetch(url, init);
    console.log(JSON.stringify({ taskId, phase: new URL(url).pathname.includes('prfplc') ? 'facility' : task.kind, status: response.status }));
    if (!response.ok) {
      let body = await response.clone().text();
      for (const secret of Object.values(keys)) for (const variant of [secret, encodeURIComponent(secret)]) if (variant) body = body.replaceAll(variant, '[redacted]');
      body = body.replace(/https?:[^\s<>"']+/gi, '[url omitted]').replace(/(?:service|serviceKey)\s*[=:]\s*[^&\s<>"']+/gi, '[credential omitted]');
      console.log(JSON.stringify({ taskId, errorBody: body.slice(0, 2000) }));
    }
    return response;
  } });
  const provider = providers[task.source as Source]!;
  if (task.kind === 'list') {
    const result = await provider.list({ city: NATIONAL_CITIES.find(city => city.id === task.city_id)!,
      from: String(task.from_date), to: String(task.to_date), page: Number(task.page), pageSize: 100 });
    console.log(JSON.stringify({ taskId, success: true, items: result.items.length, hasMore: result.hasMore }));
  } else {
    const row = db.prepare('SELECT data FROM performances WHERE source=? AND source_id=?').get(task.source, task.source_id)!;
    const result = await provider.detail(JSON.parse(String(row.data)));
    console.log(JSON.stringify({ taskId, success: true, detailState: result.detailState }));
  }
} catch (error) {
  const e = error as { name?: string; kind?: string; message?: string };
  const safeMessage = /^(http \d{3}|timeout|fetch failed|kopis detail missing|detail identity mismatch)$/.test(e.message || '') ? e.message : 'message omitted';
  console.log(JSON.stringify({ taskId, success: false, type: e.name, kind: e.kind, safeMessage }));
  process.exitCode = 1;
} finally { db.close(); }
