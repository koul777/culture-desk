import { Writable, type Duplex, type Transform } from 'node:stream';
import type { EventEmitter } from 'node:events';
import type { stream } from 'exceljs';

type WorkbookWriter = stream.xlsx.WorkbookWriter;
type Archive = Transform & { abort(): unknown; finalize(): Promise<void> };
type WorksheetInput = EventEmitter & { end(): void; pipes: Duplex[] };

// ExcelJS 4.4.0 exposes these at runtime, but omits them from index.d.ts.
// _openStream creates its custom StreamBuf, whose pipes are Archiver's normalized
// PassThrough inputs. StreamBuf/WorksheetWriter are not safe to destroy().
type RuntimeWriter = WorkbookWriter & {
  zip: Archive;
  promise: Promise<unknown>;
  _openStream(path: string): WorksheetInput;
};

/** Keep a failed streaming export from leaving a worksheet or archive waiting for EOF. */
export async function writeWorkbookBuffer(
  Writer: typeof stream.xlsx.WorkbookWriter,
  populate: (workbook: WorkbookWriter) => void,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const inputs = new Map<WorksheetInput, boolean>();
  let workbook: RuntimeWriter | undefined;
  let failure: Error | undefined;
  let reportFailure!: (error: Error) => void;
  // Resolve with the error, rather than rejecting before the commit race is attached.
  const failed = new Promise<Error>(resolve => { reportFailure = resolve; });
  const output = new Writable({
    write(chunk, _encoding, done) { chunks.push(Buffer.from(chunk)); done(); },
  });
  const closeInput = (input: WorksheetInput, ended: boolean) => {
    // Archiver.abort() removes queued tasks but explicitly does not drain their
    // sources. Drain even already-ended inputs, whose buffered bytes may be queued.
    for (const destination of input.pipes) destination.resume();
    if (!ended) input.end();
  };
  const fail = (cause: unknown) => {
    if (failure) return;
    failure = cause instanceof Error ? cause : new Error(String(cause));
    reportFailure(failure);
    // Cleanup failures must not replace the first serialization/stream error.
    if (workbook) {
      try { workbook.zip.abort(); } catch { /* Continue closing the owned streams. */ }
      try {
        workbook.zip.unpipe(output);
        // Let an already-active archive worker finish after its input reaches EOF.
        workbook.zip.resume();
      } catch { /* Continue closing the owned inputs and output. */ }
      for (const [input, ended] of inputs) {
        try { closeInput(input, ended); } catch { /* Preserve the original failure. */ }
      }
    }
    output.destroy();
    chunks.length = 0;
  };
  output.on('error', fail);

  try {
    // Match the document writer's DEFLATE level; Archiver defaults to level 1.
    workbook = new Writer({ stream: output, useStyles: true, useSharedStrings: true,
      zip: { zlib: { level: 6 } } }) as RuntimeWriter;
    workbook.zip.on('error', fail);
    void workbook.promise.catch(fail);
    const openStream = workbook._openStream.bind(workbook);
    workbook._openStream = path => {
      if (failure) throw failure;
      const input = openStream(path);
      inputs.set(input, false);
      input.on('finish', () => { inputs.set(input, true); });
      input.on('error', fail);
      for (const destination of input.pipes) destination.on('error', fail);
      // An error emitted synchronously inside append() precedes registration above.
      if (failure) { closeInput(input, false); throw failure; }
      return input;
    };
    const finalize = workbook.zip.finalize.bind(workbook.zip);
    workbook.zip.finalize = () => {
      const pending = finalize();
      // ExcelJS _finalize() listens for events but ignores this returned Promise.
      // Observe a late rejection too, including a commit continuing after abort().
      void pending.catch(fail);
      return pending;
    };
    populate(workbook);
    if (failure) throw failure;
    await Promise.race([workbook.commit(), failed.then(error => { throw error; })]);
    if (failure) throw failure;
    return Buffer.concat(chunks);
  } catch (error) {
    fail(error);
    throw failure;
  }
  // Keep error listeners installed: a cancelled commit can emit after rejection.
}
