import type { DatabaseSync } from 'node:sqlite';

/**
 * Row-level change capture for the SQLite working copy.
 *
 * The cloud store keeps a compressed base snapshot plus a journal holding the
 * latest version of each changed row. A write therefore sends only the rows it
 * actually changed instead of re-uploading the whole database.
 */
export interface JournalRow { tbl: string; pk: string; data: string | null }
export interface CollectedChanges { rows: JournalRow[]; bytes: number; fullRewrite: boolean }
interface TableInfo { name: string; columns: string[]; pk: string[] }

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;

/** Every user table in the main schema with its column order and primary key columns. */
export function describeTables(db: DatabaseSync): TableInfo[] {
  const names = db.prepare("SELECT name FROM main.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  return names.map(row => {
    const name = String(row.name);
    const info = db.prepare(`PRAGMA main.table_info(${quote(name)})`).all();
    const pk = info.filter(column => Number(column.pk) > 0).sort((a, b) => Number(a.pk) - Number(b.pk)).map(column => String(column.name));
    return { name, columns: info.map(column => String(column.name)), pk };
  });
}

/** Tables, columns and indexes. Any change forces a full base rewrite instead of journal rows. */
export function schemaSignature(db: DatabaseSync): string {
  return JSON.stringify(db.prepare("SELECT type,name,tbl_name,sql FROM main.sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all());
}

/** JSON keeps text, integers, reals and NULL as-is. BLOBs are tagged so they round-trip. */
export function encodeRow(row: Record<string, unknown>): string {
  return JSON.stringify(row, (_key, value) => {
    if (value instanceof Uint8Array) return { $blob: Buffer.from(value).toString('base64') };
    if (typeof value === 'bigint') return { $bigint: value.toString() };
    return value;
  });
}
export function decodeRow(data: string): Record<string, unknown> {
  return JSON.parse(data, (_key, value) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      if (typeof value.$blob === 'string' && Object.keys(value).length === 1) return Buffer.from(value.$blob, 'base64');
      if (typeof value.$bigint === 'string' && Object.keys(value).length === 1) return BigInt(value.$bigint);
    }
    return value;
  });
}

/**
 * Installs connection-local TEMP triggers before the store opens, so changes made
 * by schema setup, startup recovery and the request itself are all captured.
 * A changed row is recorded by primary key; its final content is read at commit.
 */
export class ChangeTracker {
  private readonly tables: TableInfo[];
  private readonly signature: string;
  private readonly untracked: boolean;
  constructor(db: DatabaseSync) {
    this.tables = describeTables(db);
    this.signature = schemaSignature(db);
    this.untracked = this.tables.some(table => !table.pk.length);
    // REPLACE conflict deletes only fire delete triggers with recursive triggers enabled.
    db.exec(`PRAGMA recursive_triggers=ON;
      CREATE TEMP TABLE IF NOT EXISTS culture_changes(tbl TEXT NOT NULL,pk TEXT NOT NULL,existed INTEGER NOT NULL,PRIMARY KEY(tbl,pk)) WITHOUT ROWID;`);
    this.tables.forEach((table, index) => {
      if (!table.pk.length) return;
      const key = (prefix: string) => `json_array(${table.pk.map(column => `${prefix}.${quote(column)}`).join(',')})`;
      // NOT EXISTS instead of OR IGNORE: an outer statement's conflict policy overrides the trigger's.
      const record = (prefix: string, existed: number) => `INSERT INTO culture_changes SELECT ${literal(table.name)},${key(prefix)},${existed}
        WHERE NOT EXISTS(SELECT 1 FROM culture_changes WHERE tbl=${literal(table.name)} AND pk=${key(prefix)});`;
      // Updates that leave every column unchanged are not changes.
      const changed = table.columns.map(column => `OLD.${quote(column)} IS NOT NEW.${quote(column)}`).join(' OR ');
      // The first touch decides whether the row existed before this operation, so a
      // row inserted and removed within one request leaves no journal entry.
      db.exec(`CREATE TEMP TRIGGER culture_change_i${index} AFTER INSERT ON ${quote(table.name)} BEGIN ${record('NEW', 0)} END;
        CREATE TEMP TRIGGER culture_change_u${index} AFTER UPDATE ON ${quote(table.name)} WHEN ${changed} BEGIN ${record('OLD', 1)} ${record('NEW', 0)} END;
        CREATE TEMP TRIGGER culture_change_d${index} AFTER DELETE ON ${quote(table.name)} BEGIN ${record('OLD', 1)} END;`);
    });
  }
  collect(db: DatabaseSync): CollectedChanges {
    if (this.untracked || schemaSignature(db) !== this.signature) return { rows: [], bytes: 0, fullRewrite: true };
    const byName = new Map(this.tables.map(table => [table.name, table]));
    const select = new Map<string, ReturnType<DatabaseSync['prepare']>>();
    const rows: JournalRow[] = [];
    let bytes = 0;
    for (const change of db.prepare('SELECT tbl,pk,existed FROM temp.culture_changes ORDER BY tbl,pk').all()) {
      const table = byName.get(String(change.tbl));
      if (!table) return { rows: [], bytes: 0, fullRewrite: true };
      if (!select.has(table.name)) select.set(table.name, db.prepare(`SELECT * FROM main.${quote(table.name)} WHERE ${table.pk.map(column => `${quote(column)}=?`).join(' AND ')}`));
      const values = JSON.parse(String(change.pk)) as (string | number | null)[];
      const row = select.get(table.name)!.get(...values) as Record<string, unknown> | undefined;
      if (!row && !Number(change.existed)) continue;
      const data = row ? encodeRow(row) : null;
      rows.push({ tbl: table.name, pk: String(change.pk), data });
      bytes += table.name.length + String(change.pk).length + (data?.length ?? 0);
    }
    return { rows, bytes, fullRewrite: false };
  }
}

/** Brings a materialized copy forward: deletions first, then the latest version of each changed row. */
export function applyJournal(db: DatabaseSync, rows: JournalRow[]): void {
  if (!rows.length) return;
  const tables = new Map(describeTables(db).map(table => [table.name, table]));
  const statements = new Map<string, ReturnType<DatabaseSync['prepare']>>();
  const statement = (sql: string) => { if (!statements.has(sql)) statements.set(sql, db.prepare(sql)); return statements.get(sql)!; };
  const table = (name: string) => {
    const info = tables.get(name);
    if (!info || !info.pk.length) throw new Error('Journal does not match the base snapshot');
    return info;
  };
  db.exec('PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE');
  try {
    for (const row of rows) if (row.data === null) {
      const info = table(row.tbl);
      statement(`DELETE FROM main.${quote(info.name)} WHERE ${info.pk.map(column => `${quote(column)}=?`).join(' AND ')}`).run(...JSON.parse(row.pk));
    }
    for (const row of rows) if (row.data !== null) {
      const info = table(row.tbl);
      const values = decodeRow(row.data);
      const columns = Object.keys(values);
      if (columns.some(column => !info.columns.includes(column))) throw new Error('Journal does not match the base snapshot');
      statement(`INSERT OR REPLACE INTO main.${quote(info.name)}(${columns.map(quote).join(',')}) VALUES(${columns.map(() => '?').join(',')})`)
        .run(...columns.map(column => values[column] as any));
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  } finally {
    db.exec('PRAGMA foreign_keys=ON');
  }
}
