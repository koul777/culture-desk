import { spawn } from 'node:child_process';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const unitTests = (await readdir(new URL('../tests/', import.meta.url)))
  .filter(name => name.endsWith('.test.ts')).sort().map(name => `tests/${name}`);
const steps = [
  ['typecheck', ['node_modules/typescript/bin/tsc', '--noEmit']],
  ['unit', ['--import', 'tsx', '--test', ...unitTests]],
  ['build', ['node_modules/vite/bin/vite.js', 'build']],
  ['browser', ['node_modules/@playwright/test/cli.js', 'test']],
];
const summary = { startedAt: new Date().toISOString(), steps: [], passed: false };
const output = new URL('../test-results/quality-summary.json', import.meta.url);
for (const [name, args] of steps) {
  console.log(`\n[quality] ${name}`);
  const start = performance.now();
  const result = await new Promise(resolve => {
    const child = spawn(process.execPath, args, { cwd: root, stdio: 'inherit', env: process.env });
    child.once('error', error => resolve({ exitCode: 1, error: error.message }));
    child.once('exit', (code, signal) => resolve({ exitCode: code ?? 1, ...(signal ? { signal } : {}) }));
  });
  summary.steps.push({ name, durationMs: Math.round(performance.now() - start), ...result });
  if (result.exitCode !== 0) { process.exitCode = result.exitCode; break; }
}
summary.passed = summary.steps.length === steps.length && summary.steps.every(step => step.exitCode === 0);
summary.completedAt = new Date().toISOString();
await mkdir(new URL('../test-results/', import.meta.url), { recursive: true });
await writeFile(output, JSON.stringify(summary, null, 2) + '\n');
console.log(`\n[quality] ${summary.passed ? 'PASS' : 'FAIL'}; report: test-results/quality-summary.json`);
