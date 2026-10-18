import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { acknowledgeDeployment, inspectSnapshot, planDailyRelease, prepareDeployment, readJson, releaseScope, selectStateArtifact,
  type DeploymentReceipt, type StateArtifact } from '../scripts/release-state.js';
import type { PublishedRefresh } from '../server/cloud/readonly-fallback.js';

const at = '2026-10-18T01:00:00.000Z';
const collection: PublishedRefresh = { status: 'complete', day: '2026-10-18', from: '2026-10-01', to: '2027-01-18',
  lastSuccessAt: at, updatedAt: at, counts: null, error: null };
const base = { day: '2026-10-18', event: 'schedule', scope: 'production', commitSha: 'commit-a', collection,
  snapshot: { sha256: 'snapshot-a', refresh: collection } };
const receipt: DeploymentReceipt = { version: 1, scope: base.scope, commitSha: base.commitSha, snapshotSha256: base.snapshot.sha256, deployedAt: at };

test('collection success without deployment acknowledgement retries deployment without recollecting', () => {
  assert.deepEqual(planDailyRelease(base), { collect: false, deploy: true, reason: 'deployment_pending' });
  assert.deepEqual(planDailyRelease({ ...base, deployed: receipt }), { collect: false, deploy: false, reason: 'deployment_current' });
  for (const deployed of [
    { ...receipt, snapshotSha256: 'older-snapshot' }, { ...receipt, commitSha: 'older-code' },
    { ...receipt, scope: 'preview-other' }, { ...receipt, deployedAt: 'invalid' },
  ]) assert.equal(planDailyRelease({ ...base, deployed }).deploy, true);
});

test('partial, stale, missing, or mismatched exports cannot suppress collection', () => {
  for (const options of [
    { ...base, collection: { ...collection, status: 'retry_wait' as const } },
    { ...base, day: '2026-10-19' }, { ...base, snapshot: undefined },
    { ...base, snapshot: { ...base.snapshot, refresh: { ...collection, updatedAt: '2026-10-18T00:00:00.000Z' } } },
  ]) assert.deepEqual(planDailyRelease({ ...options, deployed: receipt }), { collect: true, deploy: true, reason: 'collection_due' });
});

test('code pushes deploy without collecting and manual runs can redeploy an acknowledged snapshot', () => {
  assert.equal(planDailyRelease({ ...base, event: 'push', collection: undefined, deployed: receipt }).collect, false);
  assert.equal(planDailyRelease({ ...base, event: 'push', deployed: receipt }).deploy, true);
  assert.equal(planDailyRelease({ ...base, event: 'workflow_dispatch', deployed: receipt }).deploy, true);
});

const artifact = (id: number, changes: Partial<StateArtifact> = {}): StateArtifact => ({ id,
  name: 'culture-desk-state-production-checkpoint', created_at: `2026-10-18T01:00:${String(id).padStart(2, '0')}Z`,
  expired: false, workflow_run: { head_branch: 'main', head_repository_id: 7 }, ...changes });

test('restoration excludes preview/fork/expired state and accepts the newest failed-run checkpoint', () => {
  const artifacts = [artifact(1, { name: 'culture-desk-state-production-final' }), artifact(2),
    artifact(3, { workflow_run: { head_branch: 'preview', head_repository_id: 7 } }),
    artifact(4, { workflow_run: { head_branch: 'main', head_repository_id: 99 } }),
    artifact(5, { expired: true }), artifact(6, { name: `culture-desk-state-${releaseScope('refs/heads/preview')}-final` })];
  assert.equal(selectStateArtifact(artifacts, 'refs/heads/main', 7)?.id, 2);
  assert.equal(selectStateArtifact([artifact(1, { name: 'culture-desk-state' })], 'refs/heads/main', 7)?.id, 1, 'legacy main state is migrated');
  const previewRef = 'refs/heads/preview';
  const preview = artifact(2, { name: `culture-desk-state-${releaseScope(previewRef)}-final`, workflow_run: { head_branch: 'preview', head_repository_id: 7 } });
  assert.equal(selectStateArtifact([...artifacts, preview], previewRef, 7)?.id, 2);
  assert.equal(selectStateArtifact([artifact(1, { name: 'culture-desk-state', workflow_run: { head_branch: 'preview', head_repository_id: 7 } })], previewRef, 7), undefined);
  assert.notEqual(releaseScope('refs/tags/main'), 'production');
  assert.notEqual(releaseScope('refs/heads/a/b'), releaseScope('refs/heads/a-b'));
});

test('a rerun selects fresh attempt state without overwriting its earlier recovery artifact', () => {
  const first = artifact(1, { name: 'culture-desk-state-production-checkpoint-123-1' });
  const second = artifact(2, { name: 'culture-desk-state-production-final-123-2' });
  const wrongScope = artifact(3, { name: 'culture-desk-state-production-preview-final-123-2' });
  assert.equal(selectStateArtifact([first, second, wrongScope], 'refs/heads/main', 7)?.id, 2);
});

function fixture(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'culture-release-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stateDirectory = path.join(root, 'state');
  mkdirSync(stateDirectory);
  const snapshotPath = path.join(root, 'snapshot.json');
  const snapshot = JSON.stringify({ version: 1, snapshotAt: at, refresh: collection, performances: [{ id: 1 }] });
  writeFileSync(snapshotPath, snapshot);
  return { root, stateDirectory, snapshotPath, snapshot };
}

test('a failed deploy preserves its pending snapshot and a later acknowledgement closes recovery', t => {
  const { stateDirectory, snapshotPath, snapshot } = fixture(t);
  prepareDeployment(stateDirectory, snapshotPath, 'production', 'commit-a', new Date(at));
  assert.equal(existsSync(path.join(stateDirectory, 'deployment.json')), false, 'prepare never claims deployment success');
  writeFileSync(snapshotPath, '{"committed":"older baseline"}');
  prepareDeployment(stateDirectory, snapshotPath, 'production', 'commit-a', new Date(at));
  assert.equal(readFileSync(snapshotPath, 'utf8'), snapshot, 'recovery restores the saved pending snapshot');
  const identity = inspectSnapshot(snapshotPath)!;
  assert.equal(planDailyRelease({ ...base, snapshot: identity }).deploy, true);
  acknowledgeDeployment(stateDirectory, snapshotPath, 'production', 'commit-a', new Date(at));
  const deployed = readJson<DeploymentReceipt>(path.join(stateDirectory, 'deployment.json'))!;
  assert.equal(planDailyRelease({ ...base, snapshot: identity, deployed }).deploy, false);
  assert.equal(planDailyRelease({ ...base, snapshot: identity, deployed, commitSha: 'commit-b' }).deploy, true, 'a failed code deployment is retried too');
});

test('a receipt cannot acknowledge changed bytes, code, or deployment environment', t => {
  const { stateDirectory, snapshotPath } = fixture(t);
  prepareDeployment(stateDirectory, snapshotPath, 'production', 'commit-a', new Date(at));
  assert.throws(() => acknowledgeDeployment(stateDirectory, snapshotPath, 'preview-other', 'commit-a'), /acknowledgement rejected/);
  assert.throws(() => acknowledgeDeployment(stateDirectory, snapshotPath, 'production', 'commit-b'), /acknowledgement rejected/);
  writeFileSync(snapshotPath, JSON.stringify({ version: 1, snapshotAt: at, performances: [{ id: 2 }] }));
  assert.throws(() => acknowledgeDeployment(stateDirectory, snapshotPath, 'production', 'commit-a'), /acknowledgement rejected/);
  assert.equal(existsSync(path.join(stateDirectory, 'deployment.json')), false);
});

test('an invalid saved snapshot cannot overwrite the last usable deployment input', t => {
  const { stateDirectory, snapshotPath, snapshot } = fixture(t);
  writeFileSync(path.join(stateDirectory, 'public-snapshot.json'), '{"invalid":true}');
  assert.throws(() => prepareDeployment(stateDirectory, snapshotPath, 'production', 'commit-a'), /Invalid release snapshot/);
  assert.equal(readFileSync(snapshotPath, 'utf8'), snapshot);
});

test('the planning helper runs with Node alone before dependency installation', () => {
  const script = fileURLToPath(new URL('../scripts/release-state.ts', import.meta.url));
  const result = spawnSync(process.execPath, [script, 'scope'], { encoding: 'utf8', env: { ...process.env, GITHUB_REF: 'refs/heads/main', GITHUB_OUTPUT: '' } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /scope=production/);
  assert.match(result.stdout, /artifact=culture-desk-state-production/);
});

test('a corrupt saved export schedules recovery instead of permanently stopping at the planner', t => {
  const { root, stateDirectory } = fixture(t);
  writeFileSync(path.join(stateDirectory, 'public-snapshot.json'), '{broken');
  const script = fileURLToPath(new URL('../scripts/release-state.ts', import.meta.url));
  const result = spawnSync(process.execPath, [script, 'plan'], { cwd: root, encoding: 'utf8', env: {
    ...process.env, DAILY_STATE_DIRECTORY: stateDirectory, GITHUB_REF: 'refs/heads/main', GITHUB_SHA: 'commit-a', GITHUB_EVENT_NAME: 'schedule', GITHUB_OUTPUT: '',
  } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /collect=true/);
  assert.match(result.stdout, /deploy=true/);
  assert.match(result.stderr, /recovery run is required/);
});
