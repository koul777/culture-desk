import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile, readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const workspace = fileURLToPath(new URL('../../', import.meta.url));
export function argumentsOf(args = process.argv.slice(2)): Record<string, string> {
  const result: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!args[i].startsWith('--') || args[i + 1] === undefined) throw new Error(`Expected --name value: ${args[i]}`);
    result[args[i].slice(2)] = args[i + 1];
  }
  return result;
}
export const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
export function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value instanceof Date) return { $type: 'Date', iso: value.toISOString() };
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}
export const semanticHash = (value: unknown) => sha256(JSON.stringify(canonical(value)));
export function statistics(values: number[]) {
  if (!values.length) throw new Error('No samples');
  const ordered = [...values].sort((a, b) => a - b);
  const percentile = (p: number) => ordered[Math.max(0, Math.ceil(ordered.length * p) - 1)];
  return { samples: values.length, p50Ms: percentile(.5), p95Ms: percentile(.95), minMs: ordered[0], maxMs: ordered.at(-1), meanMs: values.reduce((a, b) => a + b, 0) / values.length };
}
export async function saveJson(file: string, value: unknown) {
  await mkdir(dirname(resolve(file)), { recursive: true });
  await writeFile(file, JSON.stringify(value, null, 2) + '\n');
}
export async function snapshotInfo(root: string, override?: string) {
  const path = override ? resolve(override) : resolve(root, 'server/assets/public-snapshot.json');
  const bytes = await readFile(path);
  const snapshot = JSON.parse(bytes.toString('utf8'));
  return { path, snapshot, bytes: bytes.byteLength, hash: sha256(bytes), count: snapshot.performances.length as number };
}
export async function sourceFingerprint(root: string, directories = ['server', 'web', 'shared']) {
  const files: Record<string, string> = {};
  async function walk(directory: string) {
    for (const entry of await readdir(resolve(root, directory), { withFileTypes: true })) {
      const relative = `${directory}/${entry.name}`;
      if (entry.isDirectory()) await walk(relative);
      else if (/\.(tsx?|css|html|json)$/.test(entry.name) && relative !== 'server/assets/public-snapshot.json') files[relative] = sha256(await readFile(resolve(root, relative)));
    }
  }
  for (const directory of directories) await walk(directory);
  for (const relative of ['package.json', 'package-lock.json', 'vite.config.ts']) files[relative] = sha256(await readFile(resolve(root, relative)));
  return { hash: semanticHash(files), directories, files };
}
export async function clientFingerprint(root: string) {
  const files: Record<string, string> = {};
  async function walk(directory: string) {
    for (const entry of await readdir(resolve(root, directory), { withFileTypes: true })) {
      const relative = `${directory}/${entry.name}`;
      if (entry.isDirectory()) await walk(relative);
      else files[relative] = sha256(await readFile(resolve(root, relative)));
    }
  }
  await walk('dist/client');
  return { hash: semanticHash(files), files };
}
export function coreRoutes(snapshot: any) {
  const params = new URLSearchParams({ from: snapshot.coverage?.from ?? '2026-10-01', to: snapshot.coverage?.to ?? '2027-01-17' });
  const query = params.toString();
  return [
    { name: 'bootstrap', route: '/api/bootstrap' },
    { name: 'national-search', route: `/api/performances?${query}` },
    { name: 'regional-search', route: `/api/performances?${query}&cities=yeosu,wonju` },
    { name: 'national-map', route: `/api/map?${query}` },
    { name: 'regional-map', route: `/api/map?${query}&cities=yeosu,wonju` },
    { name: 'filtered-search', route: `/api/performances?${query}&genre=음악&price=free` },
    ...(snapshot.performances.length ? [{ name: 'detail', route: `/api/performances/${snapshot.performances[0].id}` }] : []),
  ];
}
