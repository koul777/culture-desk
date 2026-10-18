import type { ChildProcess } from 'node:child_process';

/** Idempotent termination; do not disconnect IPC before kill on Windows. */
export function childStopper(child: ChildProcess) {
  let stopping: Promise<void> | undefined;
  return () => stopping ??= (async () => {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((done, reject) => {
      const timer = setTimeout(() => reject(new Error(`Child ${child.pid} did not exit within 5 seconds of termination`)), 5000);
      child.once('exit', () => { clearTimeout(timer); done(); });
      child.kill();
    });
  })();
}
