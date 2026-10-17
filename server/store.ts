import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { City, PerformanceInput, Performance, SearchFilters, SearchResult, Source, SyncRun, SyncState } from '../shared/types.js';
import { today, dateChunks } from './dates.js';

export interface Task {
  id: number; run_id: number; kind: 'list' | 'detail'; source: Source; city_id: string;
  from_date: string; to_date: string; page: number; source_id: string;
  state: string; attempts: number; available_at: string; error: string;
}
type Row = Record<string, any>;
const timestamp = () => new Date().toISOString();
export class Store {
  db: DatabaseSync;
  private defaultCities: City[];
  /** `onOpen` runs on the new connection before schema setup, e.g. to capture changes. */
  constructor(public filename: string, defaults: City[], hooks: { onOpen?: (db: DatabaseSync) => void } = {}) {
    this.defaultCities = defaults;
    if (filename !== ':memory:') mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    hooks.onOpen?.(this.db);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cities(id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS performances(id INTEGER PRIMARY KEY, source TEXT NOT NULL, source_id TEXT NOT NULL,
        city_id TEXT NOT NULL, start_date TEXT NOT NULL, end_date TEXT NOT NULL, classification TEXT NOT NULL,
        detail_state TEXT NOT NULL, data TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(source,source_id));
      CREATE INDEX IF NOT EXISTS performances_search ON performances(classification,city_id,start_date,end_date);
      CREATE TABLE IF NOT EXISTS performance_sources(performance_id INTEGER PRIMARY KEY REFERENCES performances(id), raw TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS bookmarks(performance_id INTEGER PRIMARY KEY REFERENCES performances(id), note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sync_runs(id INTEGER PRIMARY KEY, source TEXT NOT NULL, city_id TEXT NOT NULL,
        from_date TEXT NOT NULL,to_date TEXT NOT NULL,state TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,error TEXT NOT NULL DEFAULT '',detail_only INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS sync_tasks(id INTEGER PRIMARY KEY,run_id INTEGER NOT NULL REFERENCES sync_runs(id),
        kind TEXT NOT NULL,task_key TEXT NOT NULL,source TEXT NOT NULL,city_id TEXT NOT NULL,from_date TEXT NOT NULL,to_date TEXT NOT NULL,
        page INTEGER NOT NULL DEFAULT 1,source_id TEXT NOT NULL DEFAULT '',state TEXT NOT NULL DEFAULT 'queued',
        attempts INTEGER NOT NULL DEFAULT 0,available_at TEXT NOT NULL,error TEXT NOT NULL DEFAULT '',UNIQUE(run_id,kind,task_key));
      CREATE INDEX IF NOT EXISTS task_queue ON sync_tasks(state,available_at);
      CREATE INDEX IF NOT EXISTS task_run_state ON sync_tasks(run_id,state);
      CREATE TABLE IF NOT EXISTS sync_items(run_id INTEGER NOT NULL REFERENCES sync_runs(id),performance_id INTEGER NOT NULL REFERENCES performances(id),
        PRIMARY KEY(run_id,performance_id));
      CREATE TABLE IF NOT EXISTS sync_run_archive(run_id INTEGER PRIMARY KEY REFERENCES sync_runs(id),
        tasks_total INTEGER NOT NULL,tasks_done INTEGER NOT NULL,tasks_failed INTEGER NOT NULL,
        performances INTEGER NOT NULL,excluded INTEGER NOT NULL,review INTEGER NOT NULL,
        list_evidence TEXT NOT NULL,archived_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS run_coverage ON sync_runs(city_id,source,state,from_date,to_date) WHERE detail_only=0;
      INSERT OR IGNORE INTO schema_migrations VALUES(1,datetime('now'));
    `);
    for (const c of defaults) this.db.prepare('INSERT OR IGNORE INTO cities VALUES(?,?)').run(c.id, JSON.stringify(c));
    this.upgradeKnownRegions(defaults);
    // A single server owns this DB; process lock is enforced by the launcher/server.
    this.db.exec("UPDATE sync_tasks SET state='queued' WHERE state='running'; UPDATE sync_runs SET state='queued' WHERE state='running';");
  }
  private upgradeKnownRegions(defaults: City[]) {
    // Upgrade only the exact original seed codes; preserve custom cities, names and user data.
    this.transaction(() => {
      for (const [id, oldCode] of [['yeosu','4613'],['suncheon','4615']]) {
        const row=this.db.prepare('SELECT data FROM cities WHERE id=?').get(id) as Row|undefined;
        const fresh=defaults.find(c=>c.id===id);
        if(!row || !fresh || fresh.kopisSido!=='12') continue;
        const old=JSON.parse(row.data) as City;
        if(old.sido!=='전라남도' || old.kopisSido!=='46' || old.kopisSigungu!==oldCode) continue;
        const updated={...old,sido:fresh.sido,kopisSido:fresh.kopisSido,kopisSigungu:fresh.kopisSigungu,
          aliases:[...new Set([...old.aliases,...fresh.aliases])]};
        this.db.prepare('UPDATE cities SET data=? WHERE id=?').run(JSON.stringify(updated),id);
        // An empty response from retired region codes cannot certify collection coverage.
        this.db.prepare("UPDATE sync_tasks SET state='queued',attempts=0,available_at=?,error='' WHERE city_id=? AND kind='list'").run(timestamp(),id);
        this.db.prepare("UPDATE sync_runs SET state='queued',error='',updated_at=? WHERE city_id=? AND detail_only=0 AND state IN ('complete','partial')").run(timestamp(),id);
      }
    });
  }
  close() { this.db.close(); }
  cities(): City[] {
    return (this.db.prepare('SELECT data FROM cities ORDER BY rowid').all() as Row[]).map(r => {
      const city = JSON.parse(r.data) as City;
      const seed = this.defaultCities.find(c => c.id === city.id);
      // Supply map centres for existing installs without overwriting user coordinates or names.
      return { ...city, latitude: city.latitude ?? seed?.latitude, longitude: city.longitude ?? seed?.longitude };
    });
  }
  addCity(city: City) { this.db.prepare('INSERT INTO cities VALUES(?,?)').run(city.id, JSON.stringify(city)); return city; }
  transaction<T>(fn: () => T): T { this.db.exec('BEGIN IMMEDIATE'); try { const v = fn(); this.db.exec('COMMIT'); return v; } catch (e) { this.db.exec('ROLLBACK'); throw e; } }
  upsert(input: PerformanceInput, runId?: number): number { return this.upsertTracked(input, runId).id; }
  /**
   * Saves a provider record. Identical data leaves the row untouched, including
   * `updated_at`, so a daily refresh of unchanged performances writes nothing.
   */
  upsertTracked(input: PerformanceInput, runId?: number): { id: number; changed: boolean } {
    const previous = this.db.prepare(`SELECT p.id,p.city_id,p.start_date,p.end_date,p.classification,p.detail_state,p.data,s.raw
      FROM performances p LEFT JOIN performance_sources s ON s.performance_id=p.id WHERE p.source=? AND p.source_id=?`).get(input.source, input.sourceId) as Row | undefined;
    // A new list refresh must not erase already hydrated detail fields or user notes.
    let value = input;
    if (previous && input.detailState === 'pending') {
      const old = JSON.parse(previous.data) as PerformanceInput;
      if (old.detailState === 'complete') {
        value = { ...old, ...input, detailState: 'complete' };
        for (const key of ['address','price','priceType','age','runtime','cast','producer','organizer','contact','schedule','description'] as const) (value as any)[key] = old[key];
        // A list response has less location detail than the facility/detail response.
        if (old.latitude !== undefined && old.longitude !== undefined) {
          value.latitude = old.latitude; value.longitude = old.longitude; value.locationPrecision = old.locationPrecision;
        }
      }
    }
    const { raw, ...safe } = value;
    const now = timestamp();
    const data = JSON.stringify(safe), rawData = JSON.stringify(raw ?? null);
    const sameRecord = !!previous && previous.city_id === value.cityId && previous.start_date === value.startDate && previous.end_date === value.endDate
      && previous.classification === value.classification && previous.detail_state === value.detailState && previous.data === data;
    if (!sameRecord) this.db.prepare(`INSERT INTO performances(source,source_id,city_id,start_date,end_date,classification,detail_state,data,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(source,source_id) DO UPDATE SET city_id=excluded.city_id,start_date=excluded.start_date,
      end_date=excluded.end_date,classification=excluded.classification,detail_state=excluded.detail_state,data=excluded.data,updated_at=excluded.updated_at`)
      .run(value.source, value.sourceId, value.cityId, value.startDate, value.endDate, value.classification, value.detailState, data, now);
    const id = previous ? Number(previous.id) : Number((this.db.prepare('SELECT id FROM performances WHERE source=? AND source_id=?').get(value.source, value.sourceId) as Row).id);
    const sameRaw = !!previous && previous.raw === rawData;
    if (!sameRaw) this.db.prepare(`INSERT INTO performance_sources VALUES(?,?,?) ON CONFLICT(performance_id) DO UPDATE SET raw=excluded.raw,updated_at=excluded.updated_at`).run(id, rawData, now);
    if (runId) this.db.prepare('INSERT OR IGNORE INTO sync_items VALUES(?,?)').run(runId, id);
    return { id, changed: !sameRecord || !sameRaw };
  }
  internal(source: Source, sourceId: string): PerformanceInput | undefined {
    const r = this.db.prepare('SELECT p.data,s.raw FROM performances p LEFT JOIN performance_sources s ON s.performance_id=p.id WHERE source=? AND source_id=?').get(source, sourceId) as Row | undefined;
    return r ? { ...JSON.parse(r.data), raw: JSON.parse(r.raw || 'null') } : undefined;
  }
  item(id: number): Performance | undefined {
    const r = this.db.prepare('SELECT p.*,b.note,b.performance_id AS bookmarked FROM performances p LEFT JOIN bookmarks b ON b.performance_id=p.id WHERE p.id=?').get(id) as Row | undefined;
    return r ? this.mapItem(r) : undefined;
  }
  private mapItem(r: Row): Performance { return { ...JSON.parse(r.data), id: Number(r.id), updatedAt: r.updated_at, bookmarked: !!r.bookmarked, note: r.note || '' }; }
  bookmark(id: number, selected: boolean, note?: string) {
    if (!this.item(id)) throw new Error('공연을 찾을 수 없습니다.');
    if (selected) this.db.prepare(`INSERT INTO bookmarks VALUES(?,?,?) ON CONFLICT(performance_id) DO UPDATE SET note=COALESCE(?,bookmarks.note)`).run(id, note ?? '', timestamp(), note ?? null);
    else this.db.prepare('DELETE FROM bookmarks WHERE performance_id=?').run(id);
    return this.item(id)!;
  }
  search(filters: SearchFilters, all = false): SearchResult {
    const clauses = ["p.classification='performance'"]; const params: (string|number)[] = [];
    const cities = filters.cities?.split(',').filter(Boolean) || [];
    if (cities.length) { clauses.push(`p.city_id IN (${cities.map(() => '?').join(',')})`); params.push(...cities); }
    if (filters.from) { clauses.push('p.end_date>=?'); params.push(filters.from); }
    if (filters.to) { clauses.push('p.start_date<=?'); params.push(filters.to); }
    if (filters.source) { clauses.push('p.source=?'); params.push(filters.source); }
    if (filters.genre) { clauses.push("json_extract(p.data,'$.genre')=?"); params.push(filters.genre); }
    if (filters.q) { clauses.push("instr(lower(json_extract(p.data,'$.title') || ' ' || json_extract(p.data,'$.venue')),lower(?))>0"); params.push(filters.q); }
    if (filters.bookmarked === 'true') clauses.push('b.performance_id IS NOT NULL');
    if (filters.status === 'upcoming') { clauses.push('p.start_date>?'); params.push(today()); }
    if (filters.status === 'ongoing') { clauses.push('p.start_date<=? AND p.end_date>=?'); params.push(today(),today()); }
    if (filters.status === 'ended') { clauses.push('p.end_date<?'); params.push(today()); }
    const base = `FROM performances p LEFT JOIN bookmarks b ON b.performance_id=p.id WHERE ${clauses.join(' AND ')}`;
    const pendingDetails = Number((this.db.prepare(`SELECT count(*) AS n ${base} AND p.detail_state!='complete'`).get(...params) as Row).n);
    if (filters.price) { clauses.push("p.detail_state='complete' AND json_extract(p.data,'$.priceType')=?"); params.push(filters.price); }
    if (filters.age) { clauses.push("p.detail_state='complete' AND instr(json_extract(p.data,'$.age'),?)>0"); params.push(filters.age); }
    const filtered = `FROM performances p LEFT JOIN bookmarks b ON b.performance_id=p.id WHERE ${clauses.join(' AND ')}`;
    const countRows = this.db.prepare(`SELECT p.source,count(*) AS n ${filtered} GROUP BY p.source`).all(...params) as Row[];
    const sourceCounts = { kopis: 0, culture: 0 }; for (const r of countRows) sourceCounts[r.source as Source] = Number(r.n);
    const total = sourceCounts.kopis + sourceCounts.culture;
    const limit = Math.max(1, Math.min(100, Math.floor(Number(filters.limit)) || 30));
    const pages = Math.max(1, Math.ceil(total/limit)); const page = Math.max(1, Math.min(pages, Math.floor(Number(filters.page))||1));
    const rows = this.db.prepare(`SELECT p.*,b.note,b.performance_id AS bookmarked ${filtered} ORDER BY p.start_date DESC,p.id DESC ${all ? '' : 'LIMIT ? OFFSET ?'}`).all(...params, ...(all ? [] : [limit, (page-1)*limit])) as Row[];
    const sources: Source[] = filters.source ? [filters.source] : ['kopis','culture'];
    const selectedCities = cities.length ? cities : this.cities().map(c => c.id);
    const from = filters.from || today(), to = filters.to || today();
    // Compare the newest complete covering run with newer unfinished overlapping runs.
    // One grouped query preserves that precedence without two reads per region/source.
    const coverage = selectedCities.length ? this.db.prepare(`SELECT city_id,source,
      MAX(CASE WHEN state='complete' AND from_date<=? AND to_date>=? THEN id END) AS complete_id,
      MAX(CASE WHEN state!='complete' AND from_date<=? AND to_date>=? THEN id END) AS incomplete_id
      FROM sync_runs WHERE detail_only=0 AND city_id IN (${selectedCities.map(()=>'?').join(',')})
      AND source IN (${sources.map(()=>'?').join(',')}) GROUP BY city_id,source`)
      .all(from,to,to,from,...selectedCities,...sources) as Row[] : [];
    const covered = new Set(coverage.filter(row => row.complete_id !== null && (row.incomplete_id === null || Number(row.incomplete_id) < Number(row.complete_id)))
      .map(row => JSON.stringify([row.city_id,row.source])));
    const coverageIncomplete = selectedCities.some(city => sources.some(source => !covered.has(JSON.stringify([city,source]))));
    return { items: rows.map(r=>this.mapItem(r)), total, page, pages, sourceCounts, pendingDetails,
      partial: coverageIncomplete || (!!(filters.price || filters.age) && pendingDetails > 0), snapshotAt: timestamp() };
  }
  counts() {
    const rows = this.db.prepare('SELECT source,classification,count(*) AS n FROM performances GROUP BY source,classification').all() as Row[];
    return {
      source: { kopis: rows.find(r=>r.source==='kopis'&&r.classification==='performance')?.n || 0, culture: rows.find(r=>r.source==='culture'&&r.classification==='performance')?.n || 0 },
      review: rows.filter(r=>r.classification==='review').reduce((n,r)=>n+Number(r.n),0), excluded: rows.filter(r=>r.classification==='excluded').reduce((n,r)=>n+Number(r.n),0),
      bookmarks: Number((this.db.prepare('SELECT count(*) n FROM bookmarks').get() as Row).n),
      pending: Number((this.db.prepare("SELECT count(*) n FROM performances WHERE classification='performance' AND detail_state!='complete'").get() as Row).n),
    };
  }
  createRun(source: Source, city: string, from: string, to: string, detailOnly = false): number {
    const now = timestamp();
    const existing = this.db.prepare("SELECT id FROM sync_runs WHERE detail_only=0 AND source=? AND city_id=? AND from_date=? AND to_date=? AND state IN ('queued','running','quota_wait','paused','partial')").get(source,city,from,to) as Row | undefined;
    if (existing && !detailOnly) return Number(existing.id);
    const id = Number(this.db.prepare('INSERT INTO sync_runs(source,city_id,from_date,to_date,state,created_at,updated_at,detail_only) VALUES(?,?,?,?,?,?,?,?)').run(source,city,from,to,'queued',now,now,detailOnly?1:0).lastInsertRowid);
    if (!detailOnly) for (const c of dateChunks(from,to)) this.addTask(id,source,city,'list',c.from,c.to,1,'');
    return id;
  }
  addTask(runId: number, source: Source, city: string, kind: 'list'|'detail', from: string, to: string, page: number, sourceId: string): boolean {
    const key = kind==='list' ? `${from}:${to}:${page}` : sourceId;
    return Number(this.db.prepare('INSERT OR IGNORE INTO sync_tasks(run_id,kind,task_key,source,city_id,from_date,to_date,page,source_id,available_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(runId,kind,key,source,city,from,to,page,sourceId,timestamp()).changes) > 0;
  }
  hasPendingDetail(source: Source, sourceId: string): boolean {
    return !!this.db.prepare("SELECT id FROM sync_tasks WHERE kind='detail' AND source=? AND source_id=? AND state IN ('queued','running') LIMIT 1").get(source,sourceId);
  }
  nextTask(): Task | undefined {
    const row = this.db.prepare(`SELECT t.* FROM sync_tasks t JOIN sync_runs r ON r.id=t.run_id WHERE t.state='queued' AND t.available_at<=?
      AND r.state IN ('queued','running') ORDER BY CASE t.kind WHEN 'list' THEN 0 ELSE 1 END,t.id LIMIT 1`).get(timestamp()) as Row | undefined;
    if (!row) return;
    this.db.prepare("UPDATE sync_tasks SET state='running',attempts=attempts+1 WHERE id=?").run(row.id);
    this.db.prepare("UPDATE sync_runs SET state='running',updated_at=? WHERE id=?").run(timestamp(),row.run_id);
    return { ...row, attempts:Number(row.attempts)+1 } as Task;
  }
  finishTask(task: Task) { this.db.prepare("UPDATE sync_tasks SET state='done',error='' WHERE id=?").run(task.id); this.recomputeRun(task.run_id); }
  failTask(task: Task, message: string, kind: string) {
    if (kind==='auth' || kind==='quota') {
      const state = kind==='quota' ? 'quota_wait' : 'partial';
      this.db.prepare("UPDATE sync_tasks SET state='queued',error=? WHERE id=?").run(message,task.id);
      // Stop this source's other runs as well, preventing repeated invalid-key/quota calls.
      this.db.prepare("UPDATE sync_runs SET state=?,error=?,updated_at=? WHERE source=? AND state IN ('queued','running')").run(state,message,timestamp(),task.source);
    } else if (task.attempts < 3) {
      this.db.prepare("UPDATE sync_tasks SET state='queued',available_at=?,error=? WHERE id=?").run(new Date(Date.now()+2**task.attempts*1000).toISOString(),message,task.id);
    } else {
      this.db.prepare("UPDATE sync_tasks SET state='failed',error=? WHERE id=?").run(message,task.id);
      this.db.prepare('UPDATE sync_runs SET error=? WHERE id=?').run(message,task.run_id);
      this.recomputeRun(task.run_id);
    }
  }
  recomputeRun(id: number) {
    const run = this.db.prepare('SELECT state FROM sync_runs WHERE id=?').get(id) as Row;
    if (['paused','quota_wait','partial'].includes(run.state)) return;
    const counts = this.db.prepare('SELECT state,count(*) AS n FROM sync_tasks WHERE run_id=? GROUP BY state').all(id) as Row[];
    const pending=counts.some(r=>r.state==='queued'||r.state==='running'); const failed=counts.some(r=>r.state==='failed');
    this.db.prepare('UPDATE sync_runs SET state=?,updated_at=? WHERE id=?').run(pending?'running':failed?'partial':'complete',timestamp(),id);
  }
  setRunState(id: number, state: SyncState) {
    if (!this.db.prepare('SELECT id FROM sync_runs WHERE id=?').get(id)) throw new Error('수집 작업을 찾을 수 없습니다.');
    this.db.prepare('UPDATE sync_runs SET state=?,updated_at=?,error=? WHERE id=?').run(state,timestamp(),'',id);
    if (state==='queued') { this.db.prepare("UPDATE sync_tasks SET state='queued',attempts=0,available_at=?,error='' WHERE run_id=? AND state!='done'").run(timestamp(),id); this.recomputeRun(id); }
  }
  runs(limit = 200, ids?: number[]): SyncRun[] {
    if(ids && !ids.length) return [];
    const selection = ids ? `WHERE id IN (${ids.map(()=>'?').join(',')}) ORDER BY id DESC` : 'ORDER BY id DESC LIMIT ?';
    const rows=this.db.prepare(`WITH selected_runs AS MATERIALIZED (SELECT * FROM sync_runs ${selection}),
      tasks AS (SELECT t.run_id,COUNT(*) AS total,
        SUM(CASE WHEN t.state='done' THEN 1 ELSE 0 END) AS done,
        SUM(CASE WHEN t.state='failed' THEN 1 ELSE 0 END) AS failed
        FROM selected_runs r JOIN sync_tasks t ON t.run_id=r.id GROUP BY t.run_id),
      items AS (SELECT s.run_id,
        SUM(CASE WHEN p.classification='performance' THEN 1 ELSE 0 END) AS performances,
        SUM(CASE WHEN p.classification='excluded' THEN 1 ELSE 0 END) AS excluded,
        SUM(CASE WHEN p.classification='review' THEN 1 ELSE 0 END) AS review
        FROM selected_runs r JOIN sync_items s ON s.run_id=r.id JOIN performances p ON p.id=s.performance_id GROUP BY s.run_id)
      SELECT r.*,COALESCE(t.total,a.tasks_total,0) AS tasks_total,COALESCE(t.done,a.tasks_done,0) AS tasks_done,
        COALESCE(t.failed,a.tasks_failed,0) AS tasks_failed,COALESCE(i.performances,a.performances,0) AS performances,
        COALESCE(i.excluded,a.excluded,0) AS excluded,COALESCE(i.review,a.review,0) AS review
      FROM selected_runs r LEFT JOIN tasks t ON t.run_id=r.id LEFT JOIN items i ON i.run_id=r.id
        LEFT JOIN sync_run_archive a ON a.run_id=r.id ORDER BY r.id DESC`).all(...(ids || [limit])) as Row[];
    return rows.map(r=>{
      return {id:Number(r.id),source:r.source,cityId:r.city_id,from:r.from_date,to:r.to_date,detailOnly:!!r.detail_only,state:r.state,createdAt:r.created_at,updatedAt:r.updated_at,
        tasksTotal:Number(r.tasks_total),tasksDone:Number(r.tasks_done),tasksFailed:Number(r.tasks_failed),
        items:Number(r.performances),excluded:Number(r.excluded),review:Number(r.review),error:r.error};
    });
  }
  lastCollectionSync(source: Source): string | null {
    const row = this.db.prepare("SELECT MAX(updated_at) AS time FROM sync_runs WHERE source=? AND detail_only=0 AND state='complete'").get(source) as Row;
    return row.time || null;
  }
  backup(destination: string) { this.db.prepare('VACUUM INTO ?').run(destination); }
}
