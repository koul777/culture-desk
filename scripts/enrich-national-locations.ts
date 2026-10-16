import { readFileSync, writeFileSync, renameSync, statSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { readConfig } from '../server/config.js';
import { Store } from '../server/store.js';
import { acquireLock } from '../server/lock.js';
import { NATIONAL_CITIES } from '../server/providers/cities.js';
import { createProviders } from '../server/providers/index.js';
import type { PerformanceInput } from '../shared/types.js';
import { readNationalBatch } from './national-config.js';

// Run after the collector exits. Retry official venue data missing after a transient response.
// One representative performance per exact KOPIS facility ID avoids duplicate facility requests.
const { directory, filename } = readNationalBatch();
const release = acquireLock(filename);
const store = new Store(filename, NATIONAL_CITIES);
try {
  if (store.db.prepare("SELECT 1 FROM sync_runs WHERE state!='complete' LIMIT 1").get()) {
    throw new Error('Finish all national collection runs before enriching venue locations.');
  }
  let nextRequest = 0;
  let requests = 0;
  const keys = readConfig().keys;
  if (!keys.kopis) throw new Error('KOPIS key is required.');
  const newProvider = () => createProviders(keys, { fetch: async (url, init) => {
    if (Date.now() < nextRequest) await delay(nextRequest - Date.now());
    nextRequest = Date.now() + 350;
    requests++;
    return fetch(url, init);
  } }).kopis!;
  const groups = new Map<string, PerformanceInput[]>();
  const rows = store.db.prepare("SELECT source_id FROM performances WHERE source='kopis' AND classification='performance' AND detail_state='complete'").all();
  for (const row of rows) {
    const item = store.internal('kopis', String(row.source_id))!;
    if (item.locationPrecision === 'venue' && Number.isFinite(item.latitude) && Number.isFinite(item.longitude)) continue;
    const facilityId = String((item.raw as Record<string, unknown>)?.mt10id || '');
    if (!/^FC[0-9]+$/.test(facilityId)) continue;
    const group = groups.get(facilityId) || [];
    group.push(item); groups.set(facilityId, group);
  }
  let updatedPerformances = 0;
  const unresolved: string[] = [];
  for (const [facilityId, items] of groups) {
    let result: PerformanceInput | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        // A fresh reader avoids reusing the short negative cache after a failed venue request.
        result = await newProvider().detail(items[0]);
        if (result.locationPrecision === 'venue' && Number.isFinite(result.latitude) && Number.isFinite(result.longitude)) break;
        if ((result.raw as Record<string, unknown>)?.facility) break;
      } catch (error) {
        const kind = (error as { kind?: string }).kind;
        if (kind === 'auth' || kind === 'quota') throw new Error('Provider halted location enrichment; existing data is preserved.');
      }
      if (attempt < 2) await delay(2000);
    }
    const facility = (result?.raw as Record<string, unknown> | undefined)?.facility as Record<string, unknown> | undefined;
    if (!result || result.locationPrecision !== 'venue' || !Number.isFinite(result.latitude) || !Number.isFinite(result.longitude) || String(facility?.mt10id) !== facilityId) {
      unresolved.push(facilityId); continue;
    }
    store.transaction(() => {
      for (const item of items) {
        store.upsert({ ...item, latitude: result!.latitude, longitude: result!.longitude, locationPrecision: 'venue',
          address: item.address || result!.address, raw: { ...(item.raw as Record<string, unknown>), facility } });
        updatedPerformances++;
      }
    });
  }
  const checkpoint = path.join(directory, `checkpoint-locations-${Date.now()}.db`);
  store.backup(checkpoint);
  const reportFile = path.join(directory, 'progress.json');
  const report = JSON.parse(readFileSync(reportFile, 'utf8'));
  const locationEnrichment = { attemptedVenues: groups.size, updatedPerformances, unresolved, requests };
  Object.assign(report, { updatedAt: new Date().toISOString(), checkpoint, checkpointBytes: statSync(checkpoint).size, locationEnrichment });
  writeFileSync(reportFile + '.tmp', JSON.stringify(report, null, 2), 'utf8');
  renameSync(reportFile + '.tmp', reportFile);
  console.log(JSON.stringify({ checkpoint, bytes: report.checkpointBytes, ...locationEnrichment }));
} catch (error) {
  console.error(JSON.stringify({ error: 'Venue enrichment did not finish; original collection is preserved.', type: (error as Error).name }));
  process.exitCode = 1;
} finally { store.close(); release(); }
