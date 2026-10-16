import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { NATIONAL_CITIES } from '../server/providers/cities.js';
import { dateChunks } from '../server/dates.js';
import { readNationalBatch } from './national-config.js';

// Reads an immutable collector checkpoint; never modifies collection or production data.
const configured = readNationalBatch();
const directory = process.argv[2] ? path.dirname(path.resolve(process.argv[2])) : configured.directory;
const progressFile = path.join(directory, 'progress.json');
const progress = existsSync(progressFile) ? JSON.parse(readFileSync(progressFile, 'utf8')) : {};
const filename = path.resolve(process.argv[2] || progress.checkpoint || configured.filename);
const { from, to } = readNationalBatch({ ...process.env,
  NATIONAL_FROM: process.env.NATIONAL_FROM || progress.from || configured.from,
  NATIONAL_TO: process.env.NATIONAL_TO || progress.to || configured.to });
const db = new DatabaseSync(filename, { readOnly: true });
try {
  const expectedChunks = dateChunks(from, to);
  const issues: string[] = [];
  const integrity = Object.values(db.prepare('PRAGMA quick_check').get() || {})[0];
  if (integrity !== 'ok') issues.push('SQLite integrity check failed');
  const regions = NATIONAL_CITIES.map(city => ({
    id: city.id, name: `${city.sido} ${city.sigungu || city.name}`,
    sources: ['kopis', 'culture'].map(source => {
      const runs = db.prepare('SELECT id,state FROM sync_runs WHERE source=? AND city_id=? AND from_date=? AND to_date=? AND detail_only=0').all(source, city.id, from, to);
      if (runs.length !== 1) issues.push(`${source}:${city.id}: expected exactly one run`);
      const run = runs[0];
      if (!run) return { source, state: 'missing', listComplete: false, records: 0 };
      const tasks = db.prepare('SELECT kind,from_date,to_date,page,state FROM sync_tasks WHERE run_id=?').all(run.id);
      for (const chunk of expectedChunks) if (!tasks.some(task => task.kind === 'list' && task.from_date === chunk.from && task.to_date === chunk.to && task.page === 1)) {
        issues.push(`${source}:${city.id}: missing date chunk`);
      }
      const lists = tasks.filter(task => task.kind === 'list');
      const details = tasks.filter(task => task.kind === 'detail');
      const listComplete = lists.length >= expectedChunks.length && lists.every(task => task.state === 'done');
      const detailComplete = details.every(task => task.state === 'done');
      if (run.state === 'complete' && (!listComplete || !detailComplete)) issues.push(`${source}:${city.id}: invalid complete state`);
      return { source, state: run.state, listComplete, detailComplete,
        listPages: lists.length, detailTasks: details.length,
        records: Number(db.prepare('SELECT COUNT(*) n FROM sync_items WHERE run_id=?').get(run.id)?.n),
        searchable: Number(db.prepare("SELECT COUNT(*) n FROM sync_items i JOIN performances p ON p.id=i.performance_id WHERE i.run_id=? AND p.classification='performance'").get(run.id)?.n) };
    }),
  }));
  const coverage = regions.flatMap(region => region.sources);
  const items = db.prepare('SELECT data FROM performances').all().map(row => JSON.parse(String(row.data)));
  const performances = items.filter(item => item.classification === 'performance');
  const populatedCities = new Set(performances.map(item => item.cityId));
  const cityIds = new Set(NATIONAL_CITIES.map(city => city.id));
  if (items.some(item => !cityIds.has(item.cityId))) issues.push('Unknown city IDs found');
  const allComplete = coverage.length === NATIONAL_CITIES.length * 2 && coverage.every(source => source.state === 'complete') && issues.length === 0;
  const result = {
    auditedAt: new Date().toISOString(), filename, bytes: statSync(filename).size, from, to, integrity,
    expectedRegions: NATIONAL_CITIES.length, expectedSourceRuns: NATIONAL_CITIES.length * 2,
    sourceRunsComplete: coverage.filter(source => source.state === 'complete').length,
    sourceListsComplete: coverage.filter(source => source.listComplete).length,
    zeroRecordCompletedRuns: coverage.filter(source => source.state === 'complete' && source.records === 0).length,
    allComplete, issues,
    records: db.prepare('SELECT source,classification,detail_state,COUNT(*) count FROM performances GROUP BY source,classification,detail_state').all(),
    regionsWithPerformances: populatedCities.size,
    regionsWithoutPerformances: NATIONAL_CITIES.filter(city => !populatedCities.has(city.id)).map(city => ({ id: city.id, sido: city.sido, name: city.sigungu || city.name })),
    sourceSummary: ['kopis', 'culture'].map(source => ({
      source,
      performances: performances.filter(item => item.source === source).length,
      detailComplete: performances.filter(item => item.source === source && item.detailState === 'complete').length,
      venueCoordinates: performances.filter(item => item.source === source && item.locationPrecision === 'venue' && Number.isFinite(item.latitude) && Number.isFinite(item.longitude)).length,
      zeroPerformanceRegions: regions.filter(region => region.sources.some(entry => entry.source === source && entry.state === 'complete' && entry.searchable === 0)).length,
    })),
    venueCoordinates: performances.filter(item => item.locationPrecision === 'venue' && Number.isFinite(item.latitude) && Number.isFinite(item.longitude)).length,
    regions,
  };
  const output = path.join(directory, 'audit.json');
  writeFileSync(output, JSON.stringify(result, null, 2), 'utf8');
  const { regions: _regions, ...summary } = result;
  console.log(JSON.stringify({ ...summary, output }));
  if (!allComplete) process.exitCode = 2;
} finally { db.close(); }
