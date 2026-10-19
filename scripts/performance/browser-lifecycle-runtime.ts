import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium, type BrowserServer } from '@playwright/test';
import { deadline } from './poster-runtime.js';
import { workspace } from './common.js';

export type Cleanup = { action: string; pid?: number; success: boolean; error?: string };
const alive = (child: ChildProcess) => !!child.pid && child.exitCode === null && child.signalCode === null;

/** Only accepts the ChildProcess returned by this harness's own spawn/launch. */
async function killOwnedTree(child: ChildProcess) {
  if (!alive(child)) return;
  const pid = child.pid!;
  if (process.platform === 'win32') await new Promise<void>((resolve, reject) => {
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 5000 }, error => {
      if (error && alive(child)) reject(error); else resolve();
    });
  });
  else child.kill('SIGKILL');
  if (alive(child)) await deadline(new Promise<void>(resolve => child.once('exit', () => resolve())), 'Owned child exit', 5000);
}

export async function stopOwnedChild(child: ChildProcess, label: string): Promise<Cleanup[]> {
  if (!alive(child)) return [{ action: `${label}.already-exited`, pid: child.pid, success: true }];
  const actions: Cleanup[] = [];
  try {
    await deadline(new Promise<void>(resolve => { child.once('exit', () => resolve()); child.kill(); }), `${label} terminate`, 5000);
    actions.push({ action: `${label}.terminate`, pid: child.pid, success: true });
  } catch (error) {
    actions.push({ action: `${label}.terminate`, pid: child.pid, success: false, error: String(error) });
    try { await killOwnedTree(child); actions.push({ action: `${label}.owned-tree-kill`, pid: child.pid, success: true }); }
    catch (killError) { actions.push({ action: `${label}.owned-tree-kill`, pid: child.pid, success: false, error: String(killError) }); }
  }
  return actions;
}

export async function startLifecycleFixture(root: string) {
  const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./browser-server.ts', import.meta.url)),
    '--root', root, '--cache', 'normal', '--compression', 'gzip'],
  { cwd: workspace, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '', pendingLine = '';
  child.stderr!.setEncoding('utf8').on('data', text => { stderr = (stderr + text).slice(-8192); });
  try {
    const ready = await deadline(new Promise<any>((resolve, reject) => {
      child.stdout!.setEncoding('utf8').on('data', text => {
        pendingLine += text;
        if (pendingLine.length > 65536) { reject(new Error('Fixture protocol line exceeds bound')); pendingLine = ''; return; }
        const lines = pendingLine.split('\n'); pendingLine = lines.pop()!;
        for (const line of lines) {
          try { const item = JSON.parse(line); if (item.type === 'browser-server-ready') resolve(item); }
          catch { reject(new Error('Invalid fixture protocol')); }
        }
      });
      child.once('error', reject);
      child.once('exit', code => reject(new Error(`Fixture exited ${code}: ${stderr}`)));
    }), 'Lifecycle fixture startup', 30_000);
    assert.equal(ready.performances, 5649); assert.equal(ready.cacheMode, 'normal');
    assert.equal(new URL(ready.url).hostname, '127.0.0.1');
    return { child, ready, stderr: () => stderr };
  } catch (error) { await stopOwnedChild(child, 'fixture'); throw error; }
}

export async function startLifecycleBrowser() {
  return chromium.launchServer({ timeout: 30_000 });
}

export async function stopLifecycleBrowser(server: BrowserServer): Promise<Cleanup[]> {
  const child = server.process(), actions: Cleanup[] = [];
  try { await deadline(server.close(), 'Lifecycle Chromium close', 5000); actions.push({ action: 'browser.close', pid: child.pid, success: true }); }
  catch (error) {
    actions.push({ action: 'browser.close', pid: child.pid, success: false, error: String(error) });
    try { await killOwnedTree(child); actions.push({ action: 'browser.owned-tree-kill', pid: child.pid, success: true }); }
    catch (killError) { actions.push({ action: 'browser.owned-tree-kill', pid: child.pid, success: false, error: String(killError) }); }
  }
  return actions;
}

/** The supervisor owns browser/fixture separately, so a wedged worker cannot orphan them. */
export async function runLifecycleWorker(script: string, args: string[], endpoint: string, timeoutMs: number,
  onSpawn: (child: ChildProcess) => void) {
  const child = spawn(process.execPath, ['--import', 'tsx', script, ...args], { cwd: workspace, windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CULTURE_LIFECYCLE_BROWSER_WS: endpoint } });
  onSpawn(child);
  let stderr = '', line = '';
  child.stderr!.setEncoding('utf8').on('data', text => { stderr = (stderr + text).slice(-8192); });
  child.stdout!.setEncoding('utf8').on('data', text => {
    line += text;
    if (line.length > 8192) { line = ''; return; }
    const lines = line.split('\n'); line = lines.pop()!;
    for (const item of lines) {
      try { const value = JSON.parse(item); if (value.type === 'lifecycle-progress') console.log(JSON.stringify(value)); } catch {}
    }
  });
  return deadline(new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
    child.once('error', reject); child.once('exit', code => resolve({ code, stderr }));
  }), 'Lifecycle worker external wall watchdog', timeoutMs);
}
