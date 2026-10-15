import { describe, expect, test } from 'bun:test';
import {
  isPublished,
  releaseBlocker,
  releaseTarget,
  renameFor,
  stagedManifest,
} from './release-target.js';

describe('releaseTarget', () => {
  test('sem env, mantém o comportamento do upstream', () => {
    expect(releaseTarget({})).toEqual({ remote: 'origin', branch: 'main', tagPrefix: 'v' });
  });
  test('lê remote, branch e prefixo da env', () => {
    expect(
      releaseTarget({
        RELEASE_REMOTE: 'fork',
        RELEASE_BRANCH: 'softtor',
        RELEASE_TAG_PREFIX: 'softtor-v',
      }),
    ).toEqual({ remote: 'fork', branch: 'softtor', tagPrefix: 'softtor-v' });
  });
});

describe('renameFor', () => {
  test('sem PUBLISH_RENAME, devolve o nome original', () => {
    expect(renameFor('@nestbun/platform', {})).toBe('@nestbun/platform');
  });
  test('aplica o mapeamento só ao pacote citado', () => {
    const env = { PUBLISH_RENAME: '@nestbun/platform=@softtor/nestbun-platform' };
    expect(renameFor('@nestbun/platform', env)).toBe('@softtor/nestbun-platform');
    expect(renameFor('@nestbun/create', env)).toBe('@nestbun/create');
  });
});

describe('releaseBlocker', () => {
  const target = { branch: 'softtor' };
  const ok = {
    dryRun: false,
    branch: 'softtor',
    dirty: false,
    tagExists: false,
    tag: 'softtor-v0.2.0',
  };

  test('libera na branch alvo, com árvore limpa e tag nova', () => {
    expect(releaseBlocker(ok, target)).toBeNull();
  });
  test('reprova fora da branch alvo', () => {
    expect(releaseBlocker({ ...ok, branch: 'main' }, target)).toBe('switch to softtor first');
  });
  test('reprova com árvore suja', () => {
    expect(releaseBlocker({ ...ok, dirty: true }, target)).toBe('working tree is not clean');
  });
  test('reprova tag já existente, inclusive no dry-run', () => {
    expect(releaseBlocker({ ...ok, tagExists: true }, target)).toBe(
      'tag softtor-v0.2.0 already exists',
    );
    expect(releaseBlocker({ ...ok, dryRun: true, tagExists: true }, target)).toBe(
      'tag softtor-v0.2.0 already exists',
    );
  });
  test('no dry-run, não exige branch alvo nem árvore limpa', () => {
    expect(releaseBlocker({ ...ok, dryRun: true, branch: 'x', dirty: true }, target)).toBeNull();
  });
});

describe('stagedManifest', () => {
  test('troca o nome e tira scripts e devDependencies, preservando o resto', () => {
    const pkg = {
      name: '@nestbun/platform',
      version: '0.2.0',
      files: ['dist', 'src', 'README.md'],
      dependencies: { cors: '^2.8.5' },
      scripts: { prepublishOnly: 'bun run build && bun test' },
      devDependencies: { typescript: '7.0.2' },
    };
    expect(stagedManifest(pkg, '@softtor/nestbun-platform')).toEqual({
      name: '@softtor/nestbun-platform',
      version: '0.2.0',
      files: ['dist', 'src', 'README.md'],
      dependencies: { cors: '^2.8.5' },
    });
  });
});

describe('isPublished', () => {
  test('pula quando o npm devolve a mesma versão (idempotente)', () => {
    expect(isPublished(0, '0.2.0\n', '0.2.0')).toBe(true);
  });
  test('publica quando o npm não conhece a versão (404 sai com código diferente de 0)', () => {
    expect(isPublished(1, '', '0.2.0')).toBe(false);
  });
  test('publica quando o npm devolve outra versão', () => {
    expect(isPublished(0, '0.1.2\n', '0.2.0')).toBe(false);
  });
});
