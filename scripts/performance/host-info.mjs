import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const args = {};
for (let index = 2; index < process.argv.length; index += 2) {
  if (!process.argv[index].startsWith('--') || process.argv[index + 1] === undefined) throw new Error('Expected --name value');
  args[process.argv[index].slice(2)] = process.argv[index + 1];
}
const samples = Number(args.samples ?? 1), intervalMs = Number(args.interval ?? 1000);
if (!Number.isInteger(samples) || samples < 1 || samples > 60 || !Number.isInteger(intervalMs) || intervalMs < 100 || samples * intervalMs > 60000) throw new Error('Observation must be 1–60 samples and at most 60 seconds');
function tasks() {
  if (process.platform !== 'win32') return undefined;
  const lines = execFileSync('tasklist.exe', ['/fo', 'csv', '/nh'], { encoding: 'utf8', timeout: 10000 }).trim().split(/\r?\n/);
  return lines.map(line => line.split('","').map(value => value.replace(/^"|"$/g, '')))
    .filter(row => /^(node|chrome|msedge|powershell|pwsh|esbuild)\.exe$/i.test(row[0]))
    .map(row => ({ image: row[0], pid: Number(row[1]), workingSetLabel: row[4] }));
}
const cpus = os.cpus(), startedAt = new Date().toISOString(), processesBefore = tasks(), raw = [];
for (let index = 0; index < samples; index++) {
  const before = os.cpus().map(cpu => cpu.times);
  await new Promise(resolve => setTimeout(resolve, intervalMs));
  const after = os.cpus().map(cpu => cpu.times);
  const busy = after.map((times, cpuIndex) => {
    const total = Object.keys(times).reduce((sum, key) => sum + times[key] - before[cpuIndex][key], 0);
    return total ? 1 - (times.idle - before[cpuIndex].idle) / total : 0;
  });
  const row = { index, at: new Date().toISOString(), cpuBusyFraction: busy.reduce((a, b) => a + b, 0) / busy.length, freeMemoryMiB: os.freemem() / 1048576 };
  raw.push(row);
  if (args.out) console.log(JSON.stringify(row));
}
const report = { startedAt, endedAt: new Date().toISOString(), node: process.version, platform: process.platform,
  cpuModel: cpus[0]?.model, logicalCores: cpus.length, totalMemoryMiB: os.totalmem() / 1048576, intervalMs, samples,
  summary: { meanCpuBusyFraction: raw.reduce((sum, row) => sum + row.cpuBusyFraction, 0) / raw.length,
    maxCpuBusyFraction: Math.max(...raw.map(row => row.cpuBusyFraction)), minFreeMemoryMiB: Math.min(...raw.map(row => row.freeMemoryMiB)) },
  raw, processesBefore, processesAfter: samples > 1 ? tasks() : undefined };
if (args.out) { const output = resolve(args.out); await mkdir(dirname(output), { recursive: true }); await writeFile(output, JSON.stringify(report, null, 2) + '\n'); }
console.log(JSON.stringify(args.out ? { out: args.out, summary: report.summary } : report, null, 2));
