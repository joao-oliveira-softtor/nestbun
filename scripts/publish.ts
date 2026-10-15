/**
 * Publish each public package in packages/* whose (name, version) is not on npm yet.
 * With PUBLISH_RENAME ("from=to"), the package is published from a temporary copy whose
 * manifest carries the new name; the repository's package.json is never touched.
 * Pass --dry-run to print what would be published (npm pack --dry-run) without publishing.
 */
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isPublished, renameFor, stagedManifest } from './release-target.js';

const root = join(import.meta.dirname, '..', 'packages');
const dryRun = process.argv.includes('--dry-run');

for (const entry of await readdir(root, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const dir = join(root, entry.name);
  const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as {
    name: string;
    version: string;
    private?: boolean;
    files?: string[];
    scripts?: unknown;
    devDependencies?: unknown;
  };
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
        JSON.stringify(stagedManifest(pkg, name), null, 2),
      );
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
