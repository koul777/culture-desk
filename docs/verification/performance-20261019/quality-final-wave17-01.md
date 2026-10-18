# Integrated quality — wave17

`npm run quality` passed once on the frozen workspace: TypeScript, **309 unit tests across 50 files**, the production build, and **15 Chromium scenarios**. There were no skipped/flaky browser cases. All 15 offline/runtime guard attachments contain zero unexpected requests and zero browser runtime errors.

| Step | Result | Duration |
| --- | --- | ---: |
| TypeScript | PASS | 3.1 s |
| Unit tests | 309/309 PASS | 26.1 s |
| Production build | PASS | 10.6 s |
| Chromium | 15/15 PASS | 83.7 s |

Source SHA-256 remained `bfea341b03a13ae23be975a25a74fc9524ce85a709b43aa7c7ec4a8f7ed93137`. Build SHA-256 remained `bc1dce58f4ff69ea17e92d57947c8b8cce45d4f16af5ae1257f8562953e36a0f`, matching the immutable `candidate-wave17-popup-retention` build exactly. Snapshot, validation files and quality/config inputs also remained unchanged during the full run. The README coverage/count update afterward is documentation only.

The initial focused run passed the 375px dense-popup and source-footer cases, but the second marker/high-zoom case inherited the file's 375px viewport. Its pointer target became obscured, and the timeout was retained with trace/screenshot. The owner explicitly selected 1440×1000 before navigation for that desktop retention case; the first 375px case stayed unchanged. There were no product edits, forced clicks or ignored errors. The corrected case passed alone, then both cases passed again in the full run.

New footer checks cover initial loading, initial search failure with recovery controls, a real zero-result API response, and retained footer with existing results during refetch/error. The popup cases cover local paging/search, pointer/keyboard reopen, repeated same-ID locate with actual viewport visibility, cross-marker state retention and high-zoom preservation.

Evidence:

- [Full console](quality-wave17-01.txt), [step summary](quality-summary-wave17-01.json), [browser report](quality-e2e-wave17-01.json), [combined summary](quality-final-wave17-01.json).
- [Before metadata](quality-wave17-before-01.json), [focused correction metadata](quality-wave17-focused-correction-01.json), [after metadata](quality-wave17-after-01.json).
- [Initial focused report](quality-focused-wave17-01.json), [corrected single-case report](quality-focused-wave17-02.json), and preserved failure evidence in `quality-focused-wave17-01-failure/`.
- Nine screenshots with recorded hashes are preserved in `quality-wave17-images/`.

This is a functional quality result using 36 TEST records, synthetic tiles, and Chromium. It is not a performance benchmark, a live-provider check, or Safari/Firefox/3D-GPU validation. The existing large Cesium chunk warning remains; no new build error occurred. No full repeat was run after this pass.
