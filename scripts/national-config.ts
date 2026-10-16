import path from 'node:path';
import { ROOT } from '../server/config.js';
import { isDate } from '../server/dates.js';

/** Shared CLI/CI configuration. No credentials are returned or printed. */
export function readNationalBatch(env: NodeJS.ProcessEnv = process.env) {
  const from = env.NATIONAL_FROM || '2026-10-01';
  const to = env.NATIONAL_TO || '2027-01-16';
  const batch = env.NATIONAL_BATCH || 'national-20261001-20270116';
  if (!isDate(from) || !isDate(to) || from > to) throw new Error('NATIONAL_FROM/TO require valid ordered YYYY-MM-DD dates.');
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(batch)) throw new Error('NATIONAL_BATCH requires 1–100 letters, digits, underscores or hyphens.');
  if (env.NATIONAL_DIRECTORY?.includes('\0')) throw new Error('Invalid NATIONAL_DIRECTORY.');
  const directory = path.resolve(env.NATIONAL_DIRECTORY || path.join(ROOT, 'data', batch));
  if (directory === path.parse(directory).root) throw new Error('NATIONAL_DIRECTORY must be a dedicated collection directory.');
  return { from, to, batch, directory, filename: path.join(directory, 'collection.db') };
}
