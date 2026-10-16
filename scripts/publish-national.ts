import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'dotenv';
import { getSnapshotRepository } from '../server/cloud/snapshot.js';
import { importCollection } from '../server/import-collection.js';
import { Store } from '../server/store.js';
import { NATIONAL_CITIES } from '../server/providers/cities.js';
import { acquireLock } from '../server/lock.js';

// Run against a collector checkpoint, never a live database file being replaced.
// Credentials are read only from the ignored local Vercel environment file.
const [filename, importKey, destination = 'cloud'] = process.argv.slice(2);
if (!filename || !importKey) throw new Error('Usage: publish-national.ts checkpoint.db collection-id [cloud|local.db]');
const source = new DatabaseSync(path.resolve(filename), { readOnly: true });
try {
  if (destination === 'cloud') {
    const env = parse(readFileSync('.env.vercel'));
    process.env.DATABASE_URL = env.DATABASE_URL || env.POSTGRES_URL;
    const repository = getSnapshotRepository();
    const backupDir = path.resolve('data/backups'); mkdirSync(backupDir, { recursive: true });
    const backup = path.join(backupDir, `cloud-before-national-${Date.now()}.db`);
    await repository.withStore(false, async store => { store.backup(backup); });
    const result = await repository.withStore(true, async store => importCollection(source,store,importKey));
    console.log(JSON.stringify({ destination:'cloud',backup:path.relative('.',backup),...result }));
  } else {
    const unlock=acquireLock(path.resolve(destination));
    try {
      const target = new Store(path.resolve(destination),NATIONAL_CITIES);
      try { console.log(JSON.stringify({ destination:'local',...importCollection(source,target,importKey) })); }
      finally { target.close(); }
    } finally { unlock(); }
  }
} catch (error) {
  console.error(JSON.stringify({ error:'Collection publication failed; credentials omitted.',type:(error as Error).name }));
  process.exitCode = 1;
} finally { source.close(); }
