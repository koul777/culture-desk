import assert from 'node:assert/strict';
import { once, type EventEmitter } from 'node:events';
import { setImmediate } from 'node:timers/promises';
import type { Duplex, Transform, Writable } from 'node:stream';
import { test } from 'node:test';
import ExcelJS from 'exceljs';
import { writeWorkbookBuffer } from '../server/export-stream.js';

type Writer = ExcelJS.stream.xlsx.WorkbookWriter;
type Input = EventEmitter & { pipes: Duplex[] };
type Runtime = Writer & {
  stream: Writable;
  zip: Transform & {
    _state: { aborted: boolean };
    _queue: { length(): number };
    finalize(): Promise<void>;
  };
};

function observeInput(sheet: ExcelJS.Worksheet) {
  const input = (sheet as ExcelJS.Worksheet & { stream: Input }).stream;
  // Archiver uses readable-stream's PassThrough, which lacks modern Node getters
  // such as readableEnded/readableLength/writableFinished. Observe its real events.
  const destinations = input.pipes.map(source => {
    const state = { source, ended: false, finished: false };
    source.on('end', () => { state.ended = true; });
    source.on('finish', () => { state.finished = true; });
    return state;
  });
  const observation = { input, destinations, ended: false };
  input.on('finish', () => { observation.ended = true; });
  return observation;
}

async function assertCleaned(workbook: Runtime, inputs: ReturnType<typeof observeInput>[]) {
  assert.equal(workbook.stream.destroyed, true, 'failed output is destroyed');
  assert.equal(workbook.zip._state.aborted, true, 'archive is aborted');
  assert.equal(workbook.zip._queue.length(), 0, 'queued archive entries are removed');
  assert.ok(inputs.length > 0);
  for (const { destinations, ended } of inputs) {
    assert.equal(ended, true, 'every opened worksheet input receives EOF');
    assert.ok(destinations.length > 0, 'exercise actual ExcelJS normalized archive sources');
    for (const destination of destinations) {
      if (!destination.ended) await once(destination.source, 'end');
      assert.equal(destination.source.read(), null, 'aborted queued input is drained');
      assert.equal(destination.finished, true);
    }
  }
}

test('streaming export cleans all worksheet inputs after a real synchronous row serialization error', { timeout: 5000 }, async () => {
  let workbook!: Runtime;
  const inputs: ReturnType<typeof observeInput>[] = [];
  await assert.rejects(writeWorkbookBuffer(ExcelJS.stream.xlsx.WorkbookWriter, writer => {
    workbook = writer as Runtime;
    const first = writer.addWorksheet('queued'); inputs.push(observeInput(first));
    first.addRow(['queued worksheet', 'x'.repeat(100_000)]).commit();
    const second = writer.addWorksheet('invalid'); inputs.push(observeInput(second));
    // This reaches ExcelJS CellXform.prepare(), not an artificial helper exception.
    second.addRow([{ sharedFormula: 'Z99', result: 1 }]).commit();
  }), /Shared Formula master must exist/);
  await assertCleaned(workbook, inputs);
});

test('streaming export preserves asynchronous commit failure and closes uncommitted inputs', { timeout: 5000 }, async t => {
  const expected = new Error('TEST commit failed');
  let workbook!: Runtime;
  const inputs: ReturnType<typeof observeInput>[] = [];
  await assert.rejects(writeWorkbookBuffer(ExcelJS.stream.xlsx.WorkbookWriter, writer => {
    workbook = writer as Runtime;
    const sheet = writer.addWorksheet('pending'); inputs.push(observeInput(sheet));
    sheet.addRow(['pending worksheet']).commit();
    t.mock.method(writer, 'commit', async () => { await setImmediate(); throw expected; });
  }), error => error === expected);
  await assertCleaned(workbook, inputs);
});

for (const source of ['archive', 'output'] as const) {
  test(`streaming export observes early ${source} errors and a commit continuing after abort`, { timeout: 5000 }, async t => {
    const expected = new Error(`TEST early ${source} failure`);
    let workbook!: Runtime;
    const inputs: ReturnType<typeof observeInput>[] = [];
    let finishCommit!: () => void;
    const commitFinished = new Promise<void>(resolve => { finishCommit = resolve; });
    await assert.rejects(writeWorkbookBuffer(ExcelJS.stream.xlsx.WorkbookWriter, writer => {
      workbook = writer as Runtime;
      const sheet = writer.addWorksheet('complete'); inputs.push(observeInput(sheet));
      sheet.addRow(['complete worksheet']).commit(); sheet.commit();
      const originalCommit = writer.commit.bind(writer);
      t.mock.method(writer, 'commit', async () => {
        try {
          await setImmediate();
          // ExcelJS has not reached _finalize(), where it normally adds listeners.
          (source === 'archive' ? workbook.zip : workbook.stream).emit('error', expected);
          await setImmediate();
          await originalCommit();
        } finally { finishCommit(); }
      });
    }), error => error === expected);
    await assertCleaned(workbook, inputs);
    // Late QUEUECLOSED/ABORTED errors and finalize() rejection remain observed.
    await commitFinished;
    workbook.zip.emit('error', new Error('TEST later archive error'));
    workbook.stream.emit('error', new Error('TEST later output error'));
  });
}

test('streaming export observes a finalize promise rejection without an error event', { timeout: 5000 }, async () => {
  const expected = new Error('TEST finalize promise failed');
  let workbook!: Runtime;
  const inputs: ReturnType<typeof observeInput>[] = [];
  class RejectingWriter extends ExcelJS.stream.xlsx.WorkbookWriter {
    constructor(options: Partial<ExcelJS.stream.xlsx.WorkbookWriterOptions>) {
      super(options);
      (this as unknown as Runtime).zip.finalize = () => Promise.reject(expected);
    }
  }
  await assert.rejects(writeWorkbookBuffer(RejectingWriter, writer => {
    workbook = writer as Runtime;
    const sheet = writer.addWorksheet('complete'); inputs.push(observeInput(sheet));
    sheet.addRow(['complete worksheet']).commit(); sheet.commit();
  }), error => error === expected);
  await assertCleaned(workbook, inputs);
});
