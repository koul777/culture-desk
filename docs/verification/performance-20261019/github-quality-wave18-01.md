# First Linux quality failure: bounded test admission budget

Run [39158058662](https://github.com/koul777/culture-desk/actions/runs/39158058662), attempt 1, push head `27090b39317e56de15cb4998146642a479865472`, branch `feat/daily-snapshot-deploy`. The Ubuntu job ran from 2026-10-18T19:17:09Z to 19:18:06Z. Raw `gh run view --log-failed` output is preserved in `github-quality-wave18-01.txt`; unmodified run metadata is in `github-quality-wave18-01.json`.

Typecheck passed. Unit tests reported **308 passed / 1 failed / 309 total**, with no skips or cancellations, in 19,024.91ms. The quality runner stopped before build/browser. Its artifact upload succeeded. No remote rerun was requested during diagnosis.

The failing test was `three cloud deadlines mark the stalled task failed and allow later queue work to finish` (1,477.77ms). At the pushed source's `tests/cloud.test.ts:150`, the first iteration's `assert.equal(task.attempts, attempt)` received **actual 0, expected 1**. The preceding HTTP 200 assertion passed. This is not evidence that three attempted provider timeouts failed to advance the queue: the failure occurred before the first attempt was observed.

## Likely cause and limits of the evidence

This test combines a **30ms provider deadline** with an **800ms whole-tick admission budget**. `SnapshotRepository.withStore` performs actual temporary-file creation, SQLite initialization/backup, snapshot compression, and cleanup. `runCloudCollection` starts the whole-tick deadline before awaiting `claimBatch`. After that durable claim completes, its `networkBudget` guard legitimately restores claims as cancelled when insufficient budget remains; `mergeBatch` then preserves `attempts` rather than spending a provider attempt. A sufficiently delayed initial while guard can also return zero steps. The quality runner executes all test files through Node's test runner without a custom concurrency cap.

The observed zero attempts is consistent with this admission path under shared-runner load. **The exact branch is an inference**: the original test did not preserve its tick response body or provider-start count. The test's 1,477.77ms total includes setup and final snapshot inspection, so it is not a measurement of claim duration. There is no evidence here of a production timeout regression, and no production timeout or CI job limit is changed.

## Narrow test correction

Only the two real-snapshot tests with a 30ms provider deadline receive a **5,000ms finite whole-tick budget**. They still use the real repository and real abort timer, and retain their existing attempts/state/error, persisted backoff, and subsequent queue-completion assertions. New strict checks require `steps === 1`, `batches === 1`, and exactly one provider start/abort per intended deadline; the three-deadline case also requires zero starts for the paused later run, followed by exactly one successful later-run start.

This removes the unrelated 800ms snapshot-I/O performance expectation while making the intended deadline behavior explicit. Five seconds is bounded headroom, not a guarantee under arbitrary machine stalls. A future admission failure remains a failure, now reported at the response/call-count check instead of being mistaken for a consumed task timeout. No local tests/build/browser were run during diagnosis.

## Authorized focused validation

After the coordinator paused the independent lifecycle run, the two commands ran sequentially:

- `node node_modules/typescript/bin/tsc --noEmit`: exit 0, 3,133.92ms; `cloud-ci-budget-typecheck-01.txt` is intentionally empty because the successful compiler emitted no output.
- `node --import tsx --test tests/cloud.test.ts`: **18/18 passed**, zero skipped/cancelled/failed, test duration 22,320.73ms; full console is `cloud-ci-budget-tests-01.txt`. The two deadline tests passed in 1,014.69ms and 1,986.07ms respectively, including the new strict response/call-count checks.

`cloud-ci-budget-validation-01.json` preserves commands, exit codes, log hashes, and complete before/after source/client manifests. Product source stayed `82f3e500a7df24307da75da9030db2db5bea818be75595d4dd4020bc8c776179`; build stayed `f90479edaf65a0e81c5bb8cd9b1020f4680af6b20b13b21b1e3c21baba62a965`. Test and workflow bytes were also unchanged during validation. No build, browser test, whole suite, or remote rerun was performed for this correction. These local focused results do not establish a Linux CI pass.
