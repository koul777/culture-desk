# Streaming export: independent regression review

Reviewed the original baseline document writer against `server/export.ts`, `server/export-stream.ts`, the installed ExcelJS 4.4.0 implementation, existing failure tests, and paired export evidence. No measurement harness or running-soak file was changed.

## Confirmed regression and correction

The lazy ExcelJS import introduces an await before building the evidence sheet. Rows, runs, counts and cities were already captured synchronously, but query text, selected-ID text and run filtering still read caller-owned `filters`/`ids` afterward. A caller changing those objects immediately after `exportWorkbook()` could receive the original rows with different query/run evidence. The original document-writer implementation built this evidence before its first await. HTTP routing currently keeps its query objects local, limiting immediate exposure, but this broke the stated synchronous snapshot contract.

The focused regression first failed on the evidence query cell, showing the changed city/source/date instead of the original selection. The fix copies the string-valued filters and numeric ID array at function entry. `includeNotes` was already captured as a synchronous boolean. No data, styling, compression, routing or cleanup behavior changed.

The new test changes caller filters/IDs, stored title/note/run state, and closes the Store before awaiting the workbook. It verifies the original title, note, city, query text, selected ID, completed coverage state, row count and exact selected run evidence. The new case plus related streaming, core HTTP, public/privacy, fallback and capacity checks passed **13/13**.

- [Failure before correction](export-snapshot-regression-before.txt)
- [Related checks after correction](export-snapshot-regression-after.txt)
- Regression: `tests/export-snapshot.test.ts`

## Existing evidence that did not need repetition

- Five stream failure cases cover real synchronous row serialization failure, asynchronous commit rejection, early archive/output errors with a continuing commit, and a finalize Promise rejection without an error event. They assert first-error preservation, archive abort, queue removal, output destruction and worksheet input draining using ExcelJS's actual custom StreamBuf/normalized streams. The helper intentionally never calls `WorksheetWriter.destroy()`.
- Existing core/HTTP tests cover selected rows, literal formula-looking strings, Korean/URLs/unknown fields, local notes and public note omission. Fallback tests cover selected rows, saved-snapshot evidence and the 4 MiB response cap, including HEAD error bodies.
- Five paired fresh-process comparisons at both 5,649 and 22,596 rows have equal complete cell/value/style/column/view/filter semantic hashes. At 22,596 rows, median observed RSS was 916.65→476.39 MiB and observed heap 615.31→250.63 MiB. These are instrumented observation maxima including hydration, not proven absolute peaks or latency measurements. At 5,649 rows, external memory increased despite lower RSS/heap; improvement should not be described as applying to every memory category.
- Streaming commits remove retained worksheet cell objects, while captured result rows, shared strings and final ZIP buffers still consume memory. The result remains a Buffer, and cloud response capacity is checked after generation. This preserves the prior contract; it is not a hard generation-memory cap or a concurrent-export capacity guarantee.
- Database-outage annotation still reloads the workbook with the document writer. Its small functional compatibility is covered, but direct published-export memory figures must not be generalized to that fallback annotation path.

No additional functional blocker was found. The ongoing pinned sequential export soak is separate evidence for repeated-call stability; this review does not anticipate its result or infer concurrent-export capacity from it.

Paired evidence: [5,649 rows](export-memory-paired-5649.json), [22,596 rows](export-memory-paired-22596.json). Stream cleanup evidence: [five failure checks](export-stream-cleanup-tests.txt).
