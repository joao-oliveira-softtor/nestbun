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
}

export function releaseTarget(env: Env) {
  return {
    remote: env.RELEASE_REMOTE || 'origin',
    branch: env.RELEASE_BRANCH || 'main',
    tagPrefix: env.RELEASE_TAG_PREFIX ?? 'v',
  };
}

export function renameFor(name: string, env: Env): string {
  const pairs = (env.PUBLISH_RENAME ?? '').split(',').filter(Boolean);
  for (const pair of pairs) {
    const [from, to] = pair.split('=');
    if (from === name && to) return to;
  }
  return name;
}

/** Same checks, same order and same messages as the upstream release.ts. */
export function releaseBlocker(state: ReleaseState, target: { branch: string }): string | null {
  if (!state.dryRun && state.branch !== target.branch) return `switch to ${target.branch} first`;
  if (!state.dryRun && state.dirty) return 'working tree is not clean';
  if (state.tagExists) return `tag ${state.tag} already exists`;
  return null;
}

export function stagedManifest<T extends Manifest>(pkg: T, name: string) {
  const { scripts: _scripts, devDependencies: _dev, ...manifest } = pkg;
  return { ...manifest, name };
}

export function isPublished(exitCode: number, stdout: string, version: string): boolean {
  return exitCode === 0 && stdout.trim() === version;
}
