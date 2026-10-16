import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { readNationalBatch } from '../scripts/national-config.js';

test('national batch keeps the original defaults and supports isolated daily directories', () => {
  const original = readNationalBatch({});
  assert.equal(original.from, '2026-10-01'); assert.equal(original.to, '2027-01-16');
  assert.equal(original.batch, 'national-20261001-20270116');
  const directory = path.join(os.tmpdir(), 'national-daily-test');
  const daily = readNationalBatch({ NATIONAL_FROM: '2026-10-17', NATIONAL_TO: '2027-01-17', NATIONAL_BATCH: 'daily-2026-10-17', NATIONAL_DIRECTORY: directory });
  assert.deepEqual(daily, { from: '2026-10-17', to: '2027-01-17', batch: 'daily-2026-10-17', directory, filename: path.join(directory, 'collection.db') });
});

test('national batch rejects impossible, reversed and malformed dates and unsafe batch paths', () => {
  for (const env of [
    { NATIONAL_FROM: '2026-02-30' }, { NATIONAL_TO: '2026-01-01' }, { NATIONAL_FROM: '2026-1-1' },
    { NATIONAL_BATCH: '../production' }, { NATIONAL_BATCH: 'two words' }, { NATIONAL_BATCH: 'a'.repeat(101) },
    { NATIONAL_DIRECTORY: path.parse(process.cwd()).root }, { NATIONAL_DIRECTORY: 'data\0unsafe' },
  ]) assert.throws(() => readNationalBatch(env));
});
