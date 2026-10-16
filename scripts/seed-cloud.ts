import { readFileSync } from 'node:fs';
import { parse } from 'dotenv';
import { getSnapshotRepository } from '../server/cloud/snapshot.js';

// Credentials remain in ignored local environment files and are never printed.
const file=process.argv[2];
if(!file) throw new Error('Pass a validated SQLite backup filename.');
const values=parse(readFileSync('.env.vercel'));
process.env.DATABASE_URL=values.DATABASE_URL;
try {
  const inserted=await getSnapshotRepository().seedIfEmpty(readFileSync(file));
  console.log(JSON.stringify({inserted,existingDataPreserved:!inserted}));
} catch {
  console.error('Cloud initialization failed; credentials omitted.'); process.exitCode=1;
}
