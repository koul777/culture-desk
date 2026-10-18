import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { argumentsOf, saveJson, semanticHash, sha256, snapshotInfo, statistics, workspace } from './common.js';

// Attribution-only experiment. Production source is never changed. An ordinary
// string without either '<' or '&' cannot match the existing HTML/entity rules.
const args = argumentsOf();
assert.ok(args.out, '--out is required');
const samples = Number(args.samples ?? 30), warmup = 3;
assert.ok(Number.isSafeInteger(samples) && samples >= 3 && samples <= 100);
const originalText = await readFile(resolve(workspace, 'server/providers/text.ts'), 'utf8');
const originalVenue = await readFile(resolve(workspace, 'server/venue-info.ts'), 'utf8');
const anchor = "  if (!input) return '';";
assert.equal(originalText.split(anchor).length, 2, 'The targeted early-return must be unique');
const replacement = `${anchor}\n  if (!input.includes('<') && !input.includes('&')) return input.replace(/\\s+/g, ' ').trim();`;
const changedText = originalText.replace(anchor, replacement);
const scratch = resolve(workspace, 'data/performance-session-20261019', `venue-text-${Date.now()}`);
const variants: { name: string; clean: (value: unknown, venue: string) => unknown; strip: (value: string) => string; text: (value: unknown) => string }[] = [];
for (const [name, content] of [['baseline', originalText], ['candidate', changedText]]) {
  const directory = resolve(scratch, name);
  await mkdir(directory, { recursive: true });
  await writeFile(resolve(directory, 'text.ts'), content, { flag: 'wx' });
  await writeFile(resolve(directory, 'venue-info.ts'), originalVenue.replace("'./providers/text.js'", "'./text.js'"), { flag: 'wx' });
  const text = await import(pathToFileURL(resolve(directory, 'text.ts')).href);
  const venue = await import(pathToFileURL(resolve(directory, 'venue-info.ts')).href);
  variants.push({ name, clean: venue.cleanVenueInfo, strip: text.stripHtml, text: text.safeText });
}
const info = await snapshotInfo(workspace), corpus = info.snapshot.performances as any[];
const payloads = variants.map(variant => corpus.map(row => variant.clean(row.venueInfo, row.venue)));
assert.deepEqual(payloads[1], payloads[0], 'Every actual venue fact must match');
const fragments = ['', ' 공연장 ', '\r\n\t', '\u00a0', '\u200b', '한글', '<', '>', '&',
  '&amp;', '&lt;', '&gt;', '&nbsp;', '&#65;', '&#65536;', '<br/>', '</p>', '<b>A</b>',
  '<script>x</script>', '<style>p{}</style>', 'https://example.test/a?x=1&y=2', '0', '🎵'];
let syntheticCases = 0;
for (const first of fragments) for (const second of fragments) for (const third of ['', ' A ', '<br>', '&amp;']) {
  const value = first + second + third;
  assert.equal(variants[1].strip(value), variants[0].strip(value), `stripHtml mismatch: ${JSON.stringify(value)}`);
  assert.equal(variants[1].text(value), variants[0].text(value), `safeText mismatch: ${JSON.stringify(value)}`);
  syntheticCases++;
}
for (const value of [null, undefined, true, 0, 13, NaN, {}, [' A ', '<br>']]) {
  assert.equal(variants[1].text(value), variants[0].text(value), 'Non-string safeText input mismatch');
  syntheticCases++;
}
const raw: { round: number; variant: string; elapsedMs: number }[] = [];
let observedCount = 0;
for (let round = -warmup; round < samples; round++) {
  const order = Math.abs(round) % 2 ? [...variants].reverse() : variants;
  for (const variant of order) {
    const start = performance.now();
    for (const row of corpus) if (variant.clean(row.venueInfo, row.venue)) observedCount++;
    const elapsedMs = performance.now() - start;
    if (round >= 0) raw.push({ round, variant: variant.name, elapsedMs });
  }
}
assert.ok(observedCount > 0);
const summary = variants.map(variant => ({ variant: variant.name,
  elapsed: statistics(raw.filter(row => row.variant === variant.name).map(row => row.elapsedMs)) }));
const blocks = [0, 1, 2].map(block => ({ block: block + 1, variants: variants.map(variant => ({ variant: variant.name,
  elapsed: statistics(raw.filter(row => row.variant === variant.name && Math.floor(row.round * 3 / samples) === block).map(row => row.elapsedMs)) })) }));
assert.equal(sha256(await readFile(resolve(workspace, 'server/providers/text.ts'))), sha256(originalText));
assert.equal(sha256(await readFile(resolve(workspace, 'server/venue-info.ts'))), sha256(originalVenue));
const report = { at: new Date().toISOString(), node: process.version, scratch,
  scope: 'One process, AB/BA full real-corpus venue normalization passes, 3 discarded warmups, natural GC. Attribution only, not API/cold-start acceptance. Production source untouched; every output and synthetic markup/entity edge is checked before timing.',
  source: { text: sha256(originalText), venue: sha256(originalVenue), candidateText: sha256(changedText) },
  snapshot: { hash: info.hash, rows: info.count }, exactOutputHash: semanticHash(payloads[0]), syntheticCases,
  summary, blocks, raw,
};
await saveJson(args.out, report);
console.log(JSON.stringify({ out: args.out, syntheticCases, summary, blocks }));
