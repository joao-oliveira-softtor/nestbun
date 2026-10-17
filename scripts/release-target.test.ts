import { describe, expect, test } from 'bun:test';
import {
  bumpInternalDeps,
  isPublished,
  missingRenames,
  releaseBlocker,
  releaseTarget,
  renameFor,
  renameReadme,
  renameReadmeAll,
  stagedManifest,
} from './release-target.js';

const twoRenames = {
  PUBLISH_RENAME: '@nestbun/platform=@softtor/nestbun-platform,@nestbun/ws=@softtor/nestbun-ws',
};

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
  test('renomeia também os pacotes irmãos em dependencies, peers e peerDependenciesMeta', () => {
    const pkg = {
      name: '@nestbun/ws',
      version: '0.3.0',
      peerDependencies: { '@nestbun/platform': '0.3.0', '@nestjs/websockets': '^12.0.0' },
      peerDependenciesMeta: { '@nestbun/platform': { optional: false } },
      dependencies: { '@nestbun/platform': '0.3.0' },
      devDependencies: { '@nestbun/platform': 'workspace:*' },
    };
    expect(stagedManifest(pkg, '@softtor/nestbun-ws', twoRenames)).toEqual({
      name: '@softtor/nestbun-ws',
      version: '0.3.0',
      peerDependencies: { '@softtor/nestbun-platform': '0.3.0', '@nestjs/websockets': '^12.0.0' },
      peerDependenciesMeta: { '@softtor/nestbun-platform': { optional: false } },
      dependencies: { '@softtor/nestbun-platform': '0.3.0' },
    });
  });
});

describe('missingRenames', () => {
  const packages = [
    { name: '@nestbun/platform' },
    { name: '@nestbun/ws' },
    { name: '@nestbun/create', private: true },
  ];
  test('sem PUBLISH_RENAME, não exige nada', () => {
    expect(missingRenames(packages, {})).toEqual([]);
  });
  test('lista os pacotes públicos sem par e ignora os privados', () => {
    const env = { PUBLISH_RENAME: '@nestbun/platform=@softtor/nestbun-platform' };
    expect(missingRenames(packages, env)).toEqual(['@nestbun/ws']);
    expect(missingRenames(packages, twoRenames)).toEqual([]);
  });
});

describe('bumpInternalDeps', () => {
  const source = `{
  "name": "@nestbun/ws",
  "version": "0.3.0",
  "peerDependencies": {
    "@nestbun/platform": "0.2.0",
    "@nestjs/websockets": "^12.0.0"
  },
  "devDependencies": {
    "@nestbun/platform": "workspace:*"
  }
}`;
  test('leva o range interno à versão nova e preserva workspace: e o resto do arquivo', () => {
    expect(bumpInternalDeps(source, ['@nestbun/platform', '@nestbun/ws'], '0.3.0')).toBe(
      source.replace('"@nestbun/platform": "0.2.0"', '"@nestbun/platform": "0.3.0"'),
    );
  });
  test('serve ao bun.lock: leva só o peer do workspace e deixa workspace:* e o mapa de pacotes', () => {
    const lock = `    "packages/ws": {
      "name": "@nestbun/ws",
      "version": "0.3.0",
      "devDependencies": {
        "@nestbun/platform": "workspace:*",
      },
      "peerDependencies": {
        "@nestbun/platform": "0.3.0",
      },
    },
  },
  "packages": {
    "@nestbun/platform": ["@nestbun/platform@workspace:packages/platform"],`;
    expect(bumpInternalDeps(lock, ['@nestbun/platform', '@nestbun/ws'], '0.4.0')).toBe(
      lock.replace('"@nestbun/platform": "0.3.0"', '"@nestbun/platform": "0.4.0"'),
    );
  });
  test('não confunde o nome do próprio pacote com uma dependência', () => {
    const own = '{\n  "name": "@nestbun/platform",\n  "version": "0.3.0"\n}';
    expect(bumpInternalDeps(own, ['@nestbun/platform'], '0.3.0')).toBe(own);
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

describe('renameReadme', () => {
  const from = '@nestbun/platform';
  const to = '@softtor/nestbun-platform';
  test('troca todas as ocorrências do nome original', () => {
    const readme = `bun add ${from}\nimport { BunAdapter } from '${from}';\n\`${from}/sub\``;
    expect(renameReadme(readme, from, to)).toBe(
      `bun add ${to}\nimport { BunAdapter } from '${to}';\n\`${to}/sub\``,
    );
  });
  test('não altera nada quando o nome não aparece', () => {
    expect(renameReadme('sem nome aqui', from, to)).toBe('sem nome aqui');
  });
  test('regra: não troca quando o nome é prefixo de outro pacote (seguido de [A-Za-z0-9_-])', () => {
    const readme = `${from}-extra ${from}2 ${from}_x ${from}`;
    expect(renameReadme(readme, from, to)).toBe(`${from}-extra ${from}2 ${from}_x ${to}`);
  });
  test('renameReadmeAll aplica todos os pares, inclusive o de um pacote irmão', () => {
    const readme = 'bun add @nestbun/ws @nestbun/platform';
    expect(renameReadmeAll(readme, twoRenames)).toBe(
      'bun add @softtor/nestbun-ws @softtor/nestbun-platform',
    );
  });
  test('fim de frase e fim de texto contam como fronteira', () => {
    expect(renameReadme(`Use ${from}. ${from}`, from, to)).toBe(`Use ${to}. ${to}`);
  });
});
