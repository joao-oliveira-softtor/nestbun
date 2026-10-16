type Env = Record<string, string | undefined>;

export interface ReleaseState {
  dryRun: boolean;
  branch: string;
  dirty: boolean;
  tagExists: boolean;
  tag: string;
}

export interface Manifest {
  name: string;
  scripts?: unknown;
  devDependencies?: unknown;
  dependencies?: Record<string, unknown>;
  peerDependencies?: Record<string, unknown>;
  peerDependenciesMeta?: Record<string, unknown>;
  optionalDependencies?: Record<string, unknown>;
}

const DEPENDENCY_FIELDS = [
  'dependencies',
  'peerDependencies',
  'peerDependenciesMeta',
  'optionalDependencies',
] as const;

export function releaseTarget(env: Env) {
  return {
    remote: env.RELEASE_REMOTE || 'origin',
    branch: env.RELEASE_BRANCH || 'main',
    tagPrefix: env.RELEASE_TAG_PREFIX ?? 'v',
  };
}

function renamePairs(env: Env): [from: string, to: string][] {
  return (env.PUBLISH_RENAME ?? '')
    .split(',')
    .map((pair) => pair.split('=') as [string, string | undefined])
    .filter((pair): pair is [string, string] => Boolean(pair[0] && pair[1]));
}

export function renameFor(name: string, env: Env): string {
  return renamePairs(env).find(([from]) => from === name)?.[1] ?? name;
}

/**
 * With PUBLISH_RENAME set, every public package needs a pair: otherwise the release would
 * publish the renamed ones and then stop, or ship a package depending on a name nobody installs.
 */
export function missingRenames(
  packages: { name: string; private?: boolean }[],
  env: Env,
): string[] {
  if (!env.PUBLISH_RENAME) return [];
  return packages
    .filter((pkg) => !pkg.private && renameFor(pkg.name, env) === pkg.name)
    .map((pkg) => pkg.name);
}

/** Same checks, same order and same messages as the upstream release.ts. */
export function releaseBlocker(state: ReleaseState, target: { branch: string }): string | null {
  if (!state.dryRun && state.branch !== target.branch) return `switch to ${target.branch} first`;
  if (!state.dryRun && state.dirty) return 'working tree is not clean';
  if (state.tagExists) return `tag ${state.tag} already exists`;
  return null;
}

type DependencyField = (typeof DEPENDENCY_FIELDS)[number];

/** The published manifest: new name, no scripts or devDependencies, sibling packages renamed too. */
export function stagedManifest<T extends Manifest>(
  pkg: T,
  name: string,
  env: Env = {},
): Omit<T, 'scripts' | 'devDependencies' | DependencyField | 'name'> & {
  name: string;
} & Partial<Record<DependencyField, Record<string, unknown>>> {
  const { scripts: _scripts, devDependencies: _dev, ...manifest } = pkg;
  const staged: Record<string, unknown> = { ...manifest, name };
  for (const field of DEPENDENCY_FIELDS) {
    const deps = pkg[field];
    if (deps) {
      staged[field] = Object.fromEntries(
        Object.entries(deps).map(([dep, value]) => [renameFor(dep, env), value]),
      );
    }
  }
  return staged as ReturnType<typeof stagedManifest<T>>;
}

/**
 * Sets the range of every internal dependency (one of `names`) to `version` in a package.json
 * source, keeping its formatting. `workspace:` ranges (devDependencies) are left alone.
 */
export function bumpInternalDeps(source: string, names: string[], version: string): string {
  return names.reduce(
    (text, name) =>
      text.replaceAll(
        new RegExp(
          `("${name.replaceAll(/[.*+?^${}()|[\]\\/]/g, '\\$&')}": )"(?!workspace:)[^"]*"`,
          'g',
        ),
        `$1"${version}"`,
      ),
    source,
  );
}

export function isPublished(exitCode: number, stdout: string, version: string): boolean {
  return exitCode === 0 && stdout.trim() === version;
}

/**
 * Rewrites the package name in a README for a renamed publish. An occurrence followed by
 * [A-Za-z0-9_-] is another package that merely shares the prefix (`@scope/pkg-extra`) and stays.
 */
export function renameReadme(readme: string, from: string, to: string): string {
  return readme.replaceAll(from, (match, offset: number, whole: string) =>
    /[A-Za-z0-9_-]/.test(whole[offset + match.length] ?? '') ? match : to,
  );
}

/** Applies every PUBLISH_RENAME pair, so a README also points at its renamed siblings. */
export function renameReadmeAll(readme: string, env: Env): string {
  return renamePairs(env).reduce((text, [from, to]) => renameReadme(text, from, to), readme);
}
