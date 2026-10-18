import assert from 'node:assert/strict';
import { copyFile, mkdir, symlink, writeFile, constants } from 'node:fs/promises';
import { resolve, relative, dirname, isAbsolute } from 'node:path';
import { argumentsOf, clientFingerprint, saveJson, snapshotInfo, sourceFingerprint, workspace } from './common.js';

// Freeze only public runtime sources for long-running offline validation. Never copy
// .env, database files, credentials, node_modules contents or the mutable working tree.
const args = argumentsOf(), root = resolve(args.root ?? workspace);
assert.ok(args.out, '--out is required');
const output = resolve(args.out), allowed = resolve(root, 'data');
const withinData = relative(allowed, output);
assert.ok(withinData && !withinData.startsWith('..') && !isAbsolute(withinData), 'Pin must be a new directory under root/data');
const directories = args.web === 'true' ? ['server', 'shared', 'web'] : ['server', 'shared'];
const before = await sourceFingerprint(root, directories);
const build = args.web === 'true' ? await clientFingerprint(root) : undefined;
const snapshot = await snapshotInfo(root);
await mkdir(dirname(output), { recursive: true });
await mkdir(output); // Fail rather than overwrite an existing candidate or baseline.
for (const path of [...Object.keys(before.files), ...Object.keys(build?.files ?? {}), 'server/assets/public-snapshot.json', 'tsconfig.json']) {
  await mkdir(dirname(resolve(output, path)), { recursive: true });
  await copyFile(resolve(root, path), resolve(output, path), constants.COPYFILE_EXCL);
}
const after = await sourceFingerprint(root, directories);
const pinned = await sourceFingerprint(output, directories);
const pinnedSnapshot = await snapshotInfo(output);
assert.equal(before.hash, after.hash, 'Source changed while pinning');
assert.equal(before.hash, pinned.hash, 'Pinned source differs');
assert.equal(snapshot.hash, pinnedSnapshot.hash, 'Pinned public snapshot differs');
if (build) {
  assert.equal(build.hash, (await clientFingerprint(root)).hash, 'Client build changed while pinning');
  assert.equal(build.hash, (await clientFingerprint(output)).hash, 'Pinned client build differs');
}
await symlink(resolve(root, 'node_modules'), resolve(output, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
await writeFile(resolve(output, '.gitignore'), '*\n', { flag: 'wx' });
await saveJson(resolve(output, 'pin-manifest.json'), {
  at: new Date().toISOString(), root, output, node: process.version,
  scope: 'Public runtime sources and optional production web build; dependencies shared by junction, package-lock pinned. No secrets or databases.',
  source: before, build, snapshot: { bytes: snapshot.bytes, hash: snapshot.hash, rows: snapshot.count },
});
console.log(JSON.stringify({ output, sourceHash: pinned.hash, snapshotHash: snapshot.hash, rows: snapshot.count }));
