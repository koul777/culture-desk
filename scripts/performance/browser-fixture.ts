import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { workspace } from './common.js';
import { childStopper } from './child-lifecycle.js';

export async function startBrowserFixture(root: string, cache = 'miss', snapshot?: string) {
  const serverPath = fileURLToPath(new URL('./browser-server.ts', import.meta.url));
  const process = spawn(globalThis.process.execPath, ['--import', 'tsx', serverPath, '--root', root, '--cache', cache, '--compression', 'gzip', ...(snapshot ? ['--snapshot', snapshot] : [])],
    { cwd: workspace, stdio: ['ignore', 'pipe', 'pipe'], env: globalThis.process.env });
  let stderr = '';
  process.stderr.setEncoding('utf8').on('data', text => { stderr = (stderr + text).slice(-8000); });
  const stop = childStopper(process);
  try {
    const ready = await new Promise<any>((resolveReady, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error(`Browser fixture readiness timed out: ${stderr}`)), 30_000);
      const finish = (error?: Error, value?: unknown) => { clearTimeout(timer); error ? reject(error) : resolveReady(value); };
      process.stdout.setEncoding('utf8').on('data', text => {
        output += text;
        const lines = output.split('\n'); output = lines.pop() ?? '';
        for (const line of lines) {
          try { const item = JSON.parse(line); if (item.type === 'browser-server-ready') finish(undefined, item); } catch {}
        }
      });
      process.once('error', error => finish(error));
      process.once('exit', code => finish(new Error(`Fixture exited ${code}: ${stderr}`)));
    });
    return { ready, stop, stderr: () => stderr };
  } catch (error) { await stop(); throw error; }
}
