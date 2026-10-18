import { execFile } from 'node:child_process';
import { chromium, type BrowserServer, type Page, type Request, type Route } from '@playwright/test';

export async function deadline<T>(operation: Promise<T>, label: string, milliseconds = 10_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} exceeded ${milliseconds} ms`)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

async function closeServer(server: BrowserServer) {
  const actions: { action: string; success: boolean; error?: string }[] = [];
  try { await deadline(server.close(), 'Chromium server close', 5_000); actions.push({ action: 'server.close', success: true }); }
  catch (error) {
    actions.push({ action: 'server.close', success: false, error: String(error) });
    const child = server.process(), pid = child.pid;
    // This PID is obtained from our own launchServer result, never a host scan.
    if (pid && child.exitCode === null && child.signalCode === null) {
      try {
        if (process.platform === 'win32') await new Promise<void>((resolveKill, reject) => {
          execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 5_000 }, error => {
            if (error && child.exitCode === null && child.signalCode === null) reject(error); else resolveKill();
          });
        });
        else await deadline(server.kill(), 'Owned Chromium kill', 5_000);
        actions.push({ action: 'owned-process-tree-kill', success: true });
      } catch (killError) { actions.push({ action: 'owned-process-tree-kill', success: false, error: String(killError) }); }
    }
  }
  return actions;
}

export async function launchPosterBrowser() {
  const server = await chromium.launchServer({ timeout: 30_000 });
  try {
    const browser = await chromium.connect(server.wsEndpoint(), { timeout: 30_000 });
    return { browser, pid: server.process().pid, async close() {
      const actions: { action: string; success: boolean; error?: string }[] = [];
      try { await deadline(browser.close(), 'Chromium connection close', 5_000); actions.push({ action: 'browser.close', success: true }); }
      catch (error) { actions.push({ action: 'browser.close', success: false, error: String(error) }); }
      actions.push(...await closeServer(server));
      return actions;
    } };
  } catch (error) { await closeServer(server); throw error; }
}

export function rasterMetadata(body: Buffer, contentType: string) {
  const mime = contentType.split(';', 1)[0].trim().toLowerCase();
  if (mime === 'image/svg+xml' || /^\s*(?:<\?xml[^>]*>\s*)?<svg\b/i.test(body.subarray(0, 1024).toString('utf8'))) throw new Error('SVG is excluded from the raster corpus');
  let format: string | undefined, expectedMime: string | undefined;
  if (body.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) { format = 'png'; expectedMime = 'image/png'; }
  else if (body.length >= 3 && body[0] === 255 && body[1] === 216 && body[2] === 255) { format = 'jpeg'; expectedMime = 'image/jpeg'; }
  else if (['GIF87a', 'GIF89a'].includes(body.subarray(0, 6).toString('ascii'))) { format = 'gif'; expectedMime = 'image/gif'; }
  else if (body.subarray(0, 4).toString('ascii') === 'RIFF' && body.subarray(8, 12).toString('ascii') === 'WEBP') { format = 'webp'; expectedMime = 'image/webp'; }
  else if (body.subarray(4, 8).toString('ascii') === 'ftyp') {
    const size = body.readUInt32BE(0), brands: string[] = [];
    if (size >= 16 && size <= body.length && size <= 4096) {
      brands.push(body.subarray(8, 12).toString('ascii'));
      for (let offset = 16; offset + 4 <= size; offset += 4) brands.push(body.subarray(offset, offset + 4).toString('ascii'));
    }
    if (brands.some(brand => brand === 'avif' || brand === 'avis')) { format = 'avif'; expectedMime = 'image/avif'; }
  }
  if (!format || mime !== expectedMime) throw new Error(`Unsupported raster signature or MIME mismatch: ${mime}`);
  return { format, mime, signatureHex: body.subarray(0, 16).toString('hex') };
}

type RouteRecord = { id: number; url: string; resourceType: string; operation: string; state: string; hash?: string; bytes?: number; error?: string };
type RequestRecord = { id: number; url: string; terminal: string; error?: string };

export function routeLedger(page: Page) {
  const routes: RouteRecord[] = [], requests: RequestRecord[] = [], pending = new Set<Promise<void>>();
  const requestRecords = new Map<Request, RequestRecord>();
  let closing = false;
  page.on('request', request => {
    const record = { id: requests.length + 1, url: request.url(), terminal: 'pending' };
    requests.push(record); requestRecords.set(request, record);
  });
  page.on('requestfinished', request => { const record = requestRecords.get(request); if (record) record.terminal = 'finished'; });
  page.on('requestfailed', request => { const record = requestRecords.get(request); if (record) { record.terminal = 'failed'; record.error = request.failure()?.errorText; } });
  return {
    routes, requests,
    track(route: Route, operation: string, execute: () => Promise<void>, metadata: { hash?: string; bytes?: number } = {}) {
      const record: RouteRecord = { id: routes.length + 1, url: route.request().url(), resourceType: route.request().resourceType(), operation, state: 'pending', ...metadata };
      routes.push(record);
      const task = (async () => {
        try { await execute(); record.state = 'settled'; }
        catch (error) {
          record.error = String(error);
          record.state = closing && /Target (?:page, context or browser )?has been closed|Target closed|Browser has been closed/i.test(record.error) ? 'cancelled-on-close' : 'error';
        }
      })();
      pending.add(task); void task.finally(() => pending.delete(task)); return task;
    },
    beginClose() { closing = true; },
    async settle(contextClosed: boolean) {
      await deadline(Promise.all([...pending]), 'Route settlement after context close', 5_000);
      // Context close cancels outstanding requests. Preserve whether Chromium
      // emitted a terminal event or cancellation is established by close itself.
      if (contextClosed) for (const request of requests) if (request.terminal === 'pending') request.terminal = 'context-closed-no-terminal-event';
      return { pendingRoutes: pending.size, pendingRequests: requests.filter(request => request.terminal === 'pending').length,
        errors: routes.filter(route => route.state === 'error'), cancelledRoutes: routes.filter(route => route.state === 'cancelled-on-close').length,
        requestsCancelledByContext: requests.filter(request => request.terminal === 'context-closed-no-terminal-event').length };
    },
  };
}
