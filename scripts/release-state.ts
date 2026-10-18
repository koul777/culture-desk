import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { PublishedRefresh } from '../server/cloud/readonly-fallback.js';

/** A receipt exists only after the deployment command succeeds. Collection is tracked in job.json. */
export interface DeploymentReceipt {
  version: 1;
  scope: string;
  snapshotSha256: string;
  commitSha: string;
  deployedAt: string;
}
interface DeploymentAttempt extends Omit<DeploymentReceipt, 'deployedAt'> { preparedAt: string }
export interface SnapshotIdentity { sha256: string; refresh?: PublishedRefresh }
export interface StateArtifact {
  id: number;
  name: string;
  created_at: string;
  expired: boolean;
  workflow_run?: { head_branch: string; head_repository_id: number };
}
export interface ReleasePlanOptions {
  day: string;
  event: string;
  scope: string;
  commitSha: string;
  collection?: PublishedRefresh;
  snapshot?: SnapshotIdentity;
  deployed?: DeploymentReceipt;
}

export function releaseScope(ref: string): string {
  if (!ref) throw new Error('A full Git ref is required.');
  return ref === 'refs/heads/main' ? 'production' : `preview-${createHash('sha256').update(ref).digest('hex').slice(0, 20)}`;
}

/** Failed runs are eligible: their pre-deployment checkpoint is often the state we must recover. */
export function selectStateArtifact(artifacts: StateArtifact[], ref: string, repositoryId: number): StateArtifact | undefined {
  const prefix = `culture-desk-state-${releaseScope(ref)}`;
  const allowedNames = new Set([`${prefix}-checkpoint`, `${prefix}-final`]);
  if (ref === 'refs/heads/main') allowedNames.add('culture-desk-state');
  // Run-attempt suffixes let a rerun save fresh state without deleting an earlier recovery artifact.
  const isScopedAttempt = (name: string) => name.startsWith(`${prefix}-`)
    && /^(checkpoint|final)-\d+-\d+$/.test(name.slice(prefix.length + 1));
  return artifacts.filter(artifact => !artifact.expired && (allowedNames.has(artifact.name) || isScopedAttempt(artifact.name))
    && Number.isSafeInteger(artifact.id) && artifact.id > 0 && Number.isFinite(Date.parse(artifact.created_at))
    && artifact.workflow_run?.head_repository_id === repositoryId
    && `refs/heads/${artifact.workflow_run?.head_branch}` === ref)
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.id - a.id)[0];
}

export function sameCollection(a?: PublishedRefresh, b?: PublishedRefresh): boolean {
  return !!a && !!b && a.day === b.day && a.from === b.from && a.to === b.to
    && a.status === b.status && a.updatedAt === b.updatedAt;
}

/** An old/missing receipt causes a safe retry, never a false deployment success. */
export function planDailyRelease(options: ReleasePlanOptions) {
  const { collection, snapshot, deployed } = options;
  const collectedToday = collection?.day === options.day && collection.status === 'complete'
    && sameCollection(collection, snapshot?.refresh);
  const collect = options.event !== 'push' && !collectedToday;
  const acknowledged = !!snapshot && deployed?.version === 1 && deployed.scope === options.scope
    && deployed.snapshotSha256 === snapshot.sha256 && deployed.commitSha === options.commitSha
    && Number.isFinite(Date.parse(deployed.deployedAt));
  return { collect, deploy: collect || options.event !== 'schedule' || !acknowledged,
    reason: collect ? 'collection_due' : acknowledged ? 'deployment_current' : 'deployment_pending' };
}

export function readJson<T>(file: string): T | undefined {
  try { return JSON.parse(readFileSync(file, 'utf8')) as T; } catch { return undefined; }
}

export function inspectSnapshot(file: string): SnapshotIdentity | undefined {
  if (!existsSync(file)) return undefined;
  const bytes = readFileSync(file);
  const snapshot = JSON.parse(bytes.toString('utf8'));
  if (snapshot?.version !== 1 || !Number.isFinite(Date.parse(snapshot.snapshotAt))
    || !Array.isArray(snapshot.performances) || !snapshot.performances.length) throw new Error('Invalid release snapshot.');
  return { sha256: createHash('sha256').update(bytes).digest('hex'), refresh: snapshot.refresh };
}

export function writeJsonAtomic(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' }); renameSync(temporary, file); }
  finally { rmSync(temporary, { force: true }); }
}

export function copyFileAtomic(source: string, destination: string): void {
  if (path.resolve(source) === path.resolve(destination)) return;
  mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try { copyFileSync(source, temporary); renameSync(temporary, destination); }
  finally { rmSync(temporary, { force: true }); }
}

export function prepareDeployment(stateDirectory: string, snapshotPath: string, scope: string, commitSha: string, now = new Date()) {
  const savedSnapshot = path.join(stateDirectory, 'public-snapshot.json');
  if (existsSync(savedSnapshot)) {
    inspectSnapshot(savedSnapshot);
    copyFileAtomic(savedSnapshot, snapshotPath);
  }
  const snapshot = inspectSnapshot(snapshotPath);
  if (!snapshot || !commitSha) throw new Error('Snapshot and commit are required for deployment.');
  // Keep the exact deployed input even for the first push before any collection exists.
  copyFileAtomic(snapshotPath, savedSnapshot);
  const attempt: DeploymentAttempt = { version: 1, scope, commitSha, snapshotSha256: snapshot.sha256, preparedAt: now.toISOString() };
  writeJsonAtomic(path.join(stateDirectory, 'deployment-attempt.json'), attempt);
  return attempt;
}

export function acknowledgeDeployment(stateDirectory: string, snapshotPath: string, scope: string, commitSha: string, now = new Date()) {
  const attempt = readJson<DeploymentAttempt>(path.join(stateDirectory, 'deployment-attempt.json'));
  if (!attempt || attempt.version !== 1 || attempt.scope !== scope || attempt.commitSha !== commitSha
    || attempt.snapshotSha256 !== inspectSnapshot(snapshotPath)?.sha256) throw new Error('Deployment input changed; acknowledgement rejected.');
  const receipt: DeploymentReceipt = { version: 1, scope, commitSha, snapshotSha256: attempt.snapshotSha256, deployedAt: now.toISOString() };
  writeJsonAtomic(path.join(stateDirectory, 'deployment.json'), receipt);
  return receipt;
}

function output(values: Record<string, string | boolean>): void {
  for (const [name, value] of Object.entries(values)) {
    const line = `${name}=${value}\n`;
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, line);
    else process.stdout.write(line);
  }
}

// This CLI uses only Node built-ins, so no dependency installation is needed for an idle recovery slot.
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const stateDirectory = path.resolve(process.env.DAILY_STATE_DIRECTORY || 'data/daily');
  const snapshotPath = path.resolve('server/assets/public-snapshot.json');
  const scope = releaseScope(process.env.GITHUB_REF || '');
  const commitSha = process.env.GITHUB_SHA || '';
  switch (process.argv[2]) {
    case 'scope': output({ scope, artifact: `culture-desk-state-${scope}` }); break;
    case 'select-artifact': {
      const pages = readJson<Array<{ artifacts: StateArtifact[] }>>(process.argv[3]);
      const repositoryId = Number(process.env.GITHUB_REPOSITORY_ID);
      if (!Array.isArray(pages) || !pages.every(page => Array.isArray(page.artifacts))
        || !Number.isSafeInteger(repositoryId) || repositoryId <= 0) throw new Error('Invalid artifact index or repository identity.');
      const selected = selectStateArtifact(pages.flatMap(page => page.artifacts), process.env.GITHUB_REF || '', repositoryId);
      if (selected) process.stdout.write(String(selected.id));
      break;
    }
    case 'plan': {
      if (!commitSha) throw new Error('The current commit is required.');
      const savedSnapshot = path.join(stateDirectory, 'public-snapshot.json');
      let snapshot: SnapshotIdentity | undefined;
      try { snapshot = inspectSnapshot(existsSync(savedSnapshot) ? savedSnapshot : snapshotPath); }
      catch { console.error('Invalid snapshot; a recovery run is required.'); }
      output(planDailyRelease({ day: new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()),
        event: process.env.GITHUB_EVENT_NAME || '', scope, commitSha,
        collection: readJson<PublishedRefresh>(path.join(stateDirectory, 'job.json')),
        snapshot,
        deployed: readJson<DeploymentReceipt>(path.join(stateDirectory, 'deployment.json')) }));
      break;
    }
    case 'prepare': prepareDeployment(stateDirectory, snapshotPath, scope, commitSha); break;
    case 'acknowledge': acknowledgeDeployment(stateDirectory, snapshotPath, scope, commitSha); break;
    default: throw new Error('Use scope, select-artifact, plan, prepare, or acknowledge.');
  }
}
