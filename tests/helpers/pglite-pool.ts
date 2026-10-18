import { PGlite } from '@electric-sql/pglite';
import type { SnapshotClient, SnapshotPool } from '../../server/cloud/snapshot.js';

/**
 * A real PostgreSQL engine (PGlite, in-process) behind the SnapshotPool interface.
 * PGlite has a single session, so each client transaction holds a pool-wide mutex
 * from BEGIN to COMMIT/ROLLBACK. That serializes writers the way the production
 * row lock does, and lets tests inject commit failures.
 */
export class PglitePool implements SnapshotPool {
  readonly db = new PGlite();
  /** Number of committed transactions that wrote cloud store rows. */
  writes = 0;
  active = 0;
  maxActive = 0;
  /** Throw on the next statement matching this pattern (then clear). */
  failOn: RegExp | null = null;
  /** Keep failing every matching statement until cleared. */
  failAlways: RegExp | null = null;
  readonly statements: string[] = [];
  private tail: Promise<void> = Promise.resolve();
  private lock(): Promise<() => void> {
    let release!: () => void;
    const previous = this.tail;
    this.tail = new Promise<void>(resolve => { release = resolve; });
    return previous.then(() => release);
  }
  async connect(): Promise<SnapshotClient> {
    let release: (() => void) | undefined;
    let wrote = false;
    const pool = this;
    const run = async (text: string, values: any[]) => {
      pool.statements.push(text);
      for (const pattern of [pool.failOn, pool.failAlways]) if (pattern?.test(text)) {
        if (pattern === pool.failOn) pool.failOn = null;
        throw new Error('simulated persistence failure');
      }
      if (!values.length && text.includes(';')) {
        const results = await pool.db.exec(text);
        const last = results.at(-1);
        return { rows: last?.rows ?? [], rowCount: last?.affectedRows ?? 0 };
      }
      const result = await pool.db.query(text, values);
      return { rows: result.rows as any[], rowCount: result.affectedRows ?? 0 };
    };
    return {
      async query(text: string, values: any[] = []) {
        const statement = text.trim();
        if (/^BEGIN\b/i.test(statement)) {
          release = await pool.lock();
          pool.active++; pool.maxActive = Math.max(pool.maxActive, pool.active);
          wrote = false;
          try { return await run(text, values); } catch (error) { pool.active--; release(); release = undefined; throw error; }
        }
        if (/^(COMMIT|ROLLBACK)\b/i.test(statement)) {
          try {
            const result = await run(text, values);
            if (/^COMMIT/i.test(statement) && wrote) pool.writes++;
            return result;
          } finally {
            if (release) { pool.active--; release(); release = undefined; }
          }
        }
        if (/^(UPDATE|INSERT|DELETE)\s/i.test(statement) && /culture_desk_(base|delta|state)/.test(statement)) wrote = true;
        if (release) return run(text, values);
        // Statements outside a transaction still need exclusive use of the single session.
        const unlock = await pool.lock();
        try { return await run(text, values); } finally { unlock(); }
      },
      release() {
        if (release) throw new Error('the PostgreSQL transaction must finish before releasing its client');
      },
    };
  }
  /** Direct access for assertions, outside any client transaction. */
  async sql<T = any>(text: string, values: any[] = []): Promise<T[]> {
    const unlock = await this.lock();
    try { return (await this.db.query(text, values)).rows as T[]; } finally { unlock(); }
  }
  async close(): Promise<void> { await this.db.close(); }
}
