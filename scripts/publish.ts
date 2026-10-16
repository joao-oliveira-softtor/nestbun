/**
 * Publish each public package in packages/* whose (name, version) is not on npm yet.
 * With PUBLISH_RENAME ("from=to,from2=to2"), each package is published from a temporary copy
 * whose manifest carries the new name and renamed sibling dependencies; the repository's
 * package.json is never touched. Every public package needs a pair, checked before publishing.
 * Pass --dry-run to print what would be published (npm pack --dry-run) without publishing.
 */
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isPublished,
  type Manifest,
  missingRenames,
  renameFor,
  renameReadmeAll,
  stagedManifest,
} from './release-target.js';

type Package = Manifest & { version: string; private?: boolean; files?: string[] };

const root = join(import.meta.dirname, '..', 'packages');
const dryRun = process.argv.includes('--dry-run');

const packages: { dir: string; pkg: Package }[] = [];
for (const entry of await readdir(root, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const dir = join(root, entry.name);
  packages.push({ dir, pkg: JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) });
}

const missing = missingRenames(
  packages.map(({ pkg }) => pkg),
  process.env,
);
if (missing.length > 0) {
  console.error(`PUBLISH_RENAME has no pair for ${missing.join(', ')}; nothing was published`);
  process.exit(1);
}

for (const { dir, pkg } of packages) {
  if (pkg.private) continue;

  const name = renameFor(pkg.name, process.env);
  const view = Bun.spawn(['npm', 'view', `${name}@${pkg.version}`, 'version'], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const code = await view.exited;
  if (isPublished(code, await new Response(view.stdout).text(), pkg.version)) {
    console.log(`skip    ${name}@${pkg.version} (already on npm)`);
    continue;
  }

  let cwd = dir;
  let stage: string | undefined;
  let exit: number;
  try {
    if (name !== pkg.name) {
      // Runs from a staged copy: no scripts (prepublishOnly would rebuild outside the workspace)
      // and no devDependencies. dist/ was already built and tested by the release workflow.
      stage = await mkdtemp(join(tmpdir(), 'publish-'));
      // A missing entry of "files" (e.g. dist/ not built) must fail, not publish an empty tarball.
      for (const file of new Set(['package.json', 'README.md', ...(pkg.files ?? [])])) {
        await cp(join(dir, file), join(stage, file), { recursive: true });
      }
      await writeFile(
        join(stage, 'package.json'),
        JSON.stringify(stagedManifest(pkg, name, process.env), null, 2),
      );
      // The README tells readers to install and import the original names; point it at the new ones.
      const readme = join(stage, 'README.md');
      await writeFile(readme, renameReadmeAll(await readFile(readme, 'utf8'), process.env));
      cwd = stage;
    }

    console.log(`${dryRun ? 'dry-run ' : 'publish '}${name}@${pkg.version}`);
    const cmd = dryRun ? ['npm', 'pack', '--dry-run'] : ['bun', 'publish', '--access', 'public'];
    exit = await Bun.spawn(cmd, { cwd, stdout: 'inherit', stderr: 'inherit' }).exited;
  } finally {
    // Also runs when the copy throws, so the staged manifest and README never linger in /tmp.
    if (stage) await rm(stage, { recursive: true, force: true });
  }
  if (exit !== 0) process.exit(1);
}
