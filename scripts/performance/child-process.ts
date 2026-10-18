import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { workspace } from './common.js';
import { childStopper } from './child-lifecycle.js';

export async function runJsonChild(script: string, args: string[], resultType: string, timeoutMs = 60_000) {
  const start = performance.now();
  return new Promise<any>((resolveResult, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', script, ...args], { cwd: workspace, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    const stop = childStopper(child);
    let stdout = '', stderr = '', settled = false;
    let timeoutError: Error | undefined;
    const timer = setTimeout(() => {
      timeoutError = new Error(`Child exceeded ${timeoutMs} ms: ${script}`);
      void stop().then(() => finish(timeoutError), error => finish(error));
    }, timeoutMs);
    function finish(error?: Error, result?: unknown) {
      if (settled) return;
      settled = true; clearTimeout(timer); error ? reject(error) : resolveResult(result);
    }
    child.stdout.setEncoding('utf8').on('data', text => { stdout += text; });
    child.stderr.setEncoding('utf8').on('data', text => { stderr = (stderr + text).slice(-8000); });
    child.once('error', error => finish(error));
    child.once('close', code => {
      if (timeoutError) return finish(timeoutError);
      if (code !== 0) return finish(new Error(`Child failed (${code}): ${stderr}`));
      try {
        const result = stdout.trim().split('\n').map(line => JSON.parse(line)).find(item => item.type === resultType);
        if (!result) throw new Error(`Missing ${resultType}`);
        finish(undefined, { processElapsedMs: performance.now() - start, ...result });
      } catch (error) { finish(error as Error); }
    });
  });
}
