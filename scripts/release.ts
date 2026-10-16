/**
 * Cut a release: bun run release <patch|minor|major|x.y.z> [--dry-run]
 *
 * Bumps every public package in packages/* to the same new version, points the generator
 * at the new adapter (PLATFORM_VERSION, only when @nestbun/create is released too),
 * commits, tags vX.Y.Z and, after a confirmation,
 * pushes. The pushed tag triggers the Release workflow, which publishes to npm (it needs
 * the NPM_TOKEN repository secret) and creates the GitHub release.
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { bumpInternalDeps, releaseBlocker, releaseTarget } from './release-target.js';

const root = join(import.meta.dirname, '..');
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const bump = args.find((arg) => !arg.startsWith('--'));
const target = releaseTarget(process.env);

function fail(message: string): never {
  console.error(`release: ${message}`);
  process.exit(1);
}

function git(...cmd: string[]): string {
  const proc = Bun.spawnSync(['git', ...cmd], { cwd: root });
  if (proc.exitCode !== 0) fail(`git ${cmd.join(' ')} failed\n${proc.stderr.toString()}`);
  return proc.stdout.toString().trim();
}

function run(...cmd: string[]): void {
  const proc = Bun.spawnSync(cmd, { cwd: root, stdio: ['inherit', 'inherit', 'inherit'] });
  if (proc.exitCode !== 0) fail(`${cmd.join(' ')} failed`);
}

const parse = (version: string) => version.split('.').map(Number) as [number, number, number];

if (!bump) fail('usage: bun run release <patch|minor|major|x.y.z> [--dry-run]');

const packages: { file: string; json: { name: string; version: string; private?: boolean } }[] = [];
for (const entry of await readdir(join(root, 'packages'), { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const file = join(root, 'packages', entry.name, 'package.json');
  const json = JSON.parse(await readFile(file, 'utf8'));
  if (!json.private) packages.push({ file, json });
}

// Packages share one version, so the tag describes all of them: bump from the highest.
const current = packages
  .map((pkg) => pkg.json.version)
  .reduce((a, b) => (Bun.semver.order(a, b) >= 0 ? a : b));
const [major, minor, patch] = parse(current);
const next =
  bump === 'major'
    ? `${major + 1}.0.0`
    : bump === 'minor'
      ? `${major}.${minor + 1}.0`
      : bump === 'patch'
        ? `${major}.${minor}.${patch + 1}`
        : bump;
if (!/^\d+\.\d+\.\d+$/.test(next)) fail(`"${bump}" is not patch, minor, major or x.y.z`);
if (Bun.semver.order(next, current) <= 0) fail(`${next} is not newer than ${current}`);
const tag = `${target.tagPrefix}${next}`;
const blocker = releaseBlocker(
  {
    dryRun,
    branch: git('branch', '--show-current'),
    dirty: git('status', '--porcelain') !== '',
    tagExists: git('tag', '--list', tag) !== '',
    tag,
  },
  target,
);
if (blocker) fail(blocker);

const [nextMajor, nextMinor] = parse(next);
const platformRange = `^${nextMajor}.${nextMinor}.0`;
// The generator follows the new adapter only when it ships too. A fork that keeps
// @nestbun/create private publishes the adapter under another name, so generated projects
// must keep depending on the upstream @nestbun/platform range.
const pinScaffold = packages.some((pkg) => pkg.json.name === '@nestbun/create');
const scaffold = join(root, 'packages/create/src/scaffold.ts');
const scaffoldSource = await readFile(scaffold, 'utf8');
const pinned = /PLATFORM_VERSION = '[^']*'/;
if (pinScaffold && !pinned.test(scaffoldSource))
  fail('PLATFORM_VERSION not found in packages/create/src/scaffold.ts');

for (const pkg of packages) console.log(`${pkg.json.name}  ${pkg.json.version} → ${next}`);
console.log(
  pinScaffold
    ? `PLATFORM_VERSION → ${platformRange}`
    : 'PLATFORM_VERSION unchanged (@nestbun/create is private, not released)',
);
if (dryRun) {
  console.log(
    `dry run: would commit "chore(release): ${tag}", tag ${tag} and push ${target.branch} to ${target.remote}`,
  );
  process.exit(0);
}

// Siblings depend on each other at the exact shared version (e.g. @nestbun/ws on @nestbun/platform).
const names = packages.map((pkg) => pkg.json.name);
for (const pkg of packages) {
  const source = await readFile(pkg.file, 'utf8');
  const bumped = source.replace(/"version": "[^"]*"/, `"version": "${next}"`);
  await writeFile(pkg.file, bumpInternalDeps(bumped, names, next));
}
if (pinScaffold) {
  await writeFile(
    scaffold,
    scaffoldSource.replace(pinned, `PLATFORM_VERSION = '${platformRange}'`),
  );
}

// `bun install` records the new workspace versions but leaves the peer ranges of the workspaces
// stale in bun.lock, and the Bun canary then rejects --frozen-lockfile.
const lockFile = join(root, 'bun.lock');
await writeFile(lockFile, bumpInternalDeps(await readFile(lockFile, 'utf8'), names, next));
run('bun', 'install');
run('bun', 'run', 'build');
run('bun', 'run', 'test');

git('add', '-A');
git('commit', '-m', `chore(release): ${tag}`);
git('tag', tag);

if (
  prompt(
    `Push ${target.branch} and ${tag} to ${target.remote}? This publishes to npm. [y/N]`,
  )?.toLowerCase() !== 'y'
) {
  console.log(`Not pushed. Publish later with: git push ${target.remote} ${target.branch} ${tag}`);
  console.log(`Undo with: git tag -d ${tag} && git reset --hard HEAD~1`);
  process.exit(0);
}
run('git', 'push', target.remote, target.branch, tag);
console.log(`Pushed ${tag} to ${target.remote}`);
