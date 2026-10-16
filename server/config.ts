import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'dotenv';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export interface Config {
  port: number; databasePath: string; keys: { kopis: string; culture: string };
  requestIntervalMs: number; syncIntervalHours: number;
  vworld?: {apiKey:string};
}
export function readConfig(envPath = path.join(ROOT, '.env'), runtimeEnv: NodeJS.ProcessEnv = process.env): Config {
  const env = { ...runtimeEnv, ...(existsSync(envPath) ? parse(readFileSync(envPath)) : {}) };
  const number = (s: string | undefined, fallback: number, min: number, max: number) => {
    const n = Number(s); return s && Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
  };
  return {
    port: Math.floor(number(env.PORT, 4317, 1024, 65535)),
    databasePath: path.resolve(ROOT, env.DATABASE_PATH || './data/culture.db'),
    keys: { kopis: (env.KOPIS_API_KEY || '').trim(), culture: (env.CULTURE_API_KEY || '').trim() },
    vworld: {apiKey:(env.VWORLD_API_KEY || '').trim()},
    requestIntervalMs: number(env.REQUEST_INTERVAL_MS, 350, 100, 60000),
    syncIntervalHours: number(env.SYNC_INTERVAL_HOURS, 24, 1, 720),
  };
}
