# Contributing

Thanks for helping out. Bug reports, compatibility findings, docs fixes and pull requests are all welcome.

## Reporting a bug or an incompatibility

[Open an issue](https://github.com/mguay22/nestbun/issues) with:

- your Bun, NestJS and `@nestbun/platform` versions
- the smallest controller or module that reproduces it
- what you expected, and what happened instead (if it behaves differently on `@nestjs/platform-express`, say so: matching Express is the goal)

Check the [compatibility table](https://mguay22.github.io/nestbun/docs/compatibility/) and the [roadmap](https://mguay22.github.io/nestbun/docs/roadmap/) first; some gaps are known and planned.

## Setup

Requires Bun ≥ 1.4 (`bun upgrade`).

```bash
git clone https://github.com/<you>/nestbun.git
cd nestbun
bun install         # also installs the git hooks
bun run build       # first: the example type-checks against the adapter's emitted declarations
```

## Where things live

```
packages/platform   the adapter (src/) and its integration tests (test/)
packages/ws         @nestbun/ws: WebSocket gateways on the HTTP port
packages/socket.io  @nestbun/socket.io: Socket.IO gateways on the HTTP port
packages/create     the generator; templates/base is the starter it copies
examples/basic      minimal app: REST + Zod validation + SSE
bench/              same app on express / fastify / bun adapters
apps/www            landing page + docs (Astro + Starlight); pages are in src/content/docs/docs/
```

## Making a change

1. Branch off `main`.
2. Make the change, with a test:
   - Adapter behavior gets an integration test in `packages/platform/test` that boots a real Nest app on `BunAdapter` and asserts what a client would observe. `swagger.test.ts` is a good one to copy.
   - Generator changes get a test in `packages/create/test`.
3. Update the docs in `apps/www/src/content/docs/docs/` if users will notice the change. A new ✅ row in the compatibility table goes in both `compatibility.md` and `packages/platform/README.md`, and needs a test behind it.
4. Run the checks CI runs:

   ```bash
   bun run build
   bun run lint
   bun run format:check   # bun run format fixes it
   bun run typecheck
   bun run test
   ```

Useful while working:

```bash
bun test packages/platform/test/routing.test.ts   # one test file
cd examples/basic && bun dev                      # http://localhost:3000/cats
bun run --filter '@nestbun/www' dev               # docs site
```

## Dependencies

- Keep `@nestbun/platform`'s runtime dependencies minimal; talk to us in an issue before adding one.
- Pin dev dependencies to exact versions (`bun add -d -E <pkg>`) and commit `bun.lock`. CI installs with `--frozen-lockfile`.

## Commit messages

Commits follow [Conventional Commits](https://www.conventionalcommits.org), checked by a git hook:

```
type(scope): summary
```

- **type**: `feat`, `fix`, `docs`, `test`, `refactor`, `perf`, `build`, `ci`, `chore`, `revert`, `style`
- **scope** (optional): `platform`, `create`, `ws`, `socket.io`, `www`, `bench`

```
fix(platform): honor bodyLimit on urlencoded bodies
test(platform): cover @nestjs/throttler
docs: explain trustProxy
```

A second hook lints and formats the files you staged.

## Pull requests

- Keep a pull request to one change, and give it a Conventional Commits title: it becomes the commit on `main` when we squash-merge.
- Say what the change does and how you tested it.
- On your first pull request, CI does not start until a maintainer approves the run, so the checks may be missing for a while. That is expected.
- A failure only on Bun `canary` is usually upstream and will not block your change.

By contributing you agree that your work is licensed under the [MIT License](./LICENSE).

## The Softtor fork (`softtor` branch)

`joao-oliveira-softtor/nestbun` carries the adapter for the Softtor CRM while upstream is unresponsive. Work lands on `softtor` (the fork's default branch, protected: PR required, checks `test (ubuntu-latest, latest)` and `test (macos-latest, latest)`). `main` only mirrors `mguay22/nestbun`. The fork's `Release` (`v*` tags) and `Landing page` workflows are disabled: never push a `v*` tag to the fork.

Upstream PRs already carried in `softtor` (all are ancestors of the branch):

| Upstream PR | Branch                         |
| ----------- | ------------------------------ |
| #1          | `test/ecosystem-compat`        |
| #7          | `fix/warn-ws-upgrade-listener` |
| #8          | `test/security-hooks`          |
| #9          | `test/static-last-modified`    |
| #10         | `test/unix-socket`             |
| #11         | `test/sse-disconnect`          |
| #12         | `test/graceful-shutdown`       |
| #13         | `test/https-options`           |
| #14         | `test/view-engines`            |

### Syncing with upstream

```bash
git fetch origin && git checkout main && git merge --ff-only origin/main && git push fork main
git fetch fork && git checkout -b sync/upstream-YYYY-MM-DD fork/softtor && git merge main   # then run the CI checks
```

Open the PR against `softtor` and merge it with a **merge commit**, not squash: squash drops the ancestry and every later sync conflicts on the same files. On conflicts (for example upstream squash-merged #7–#14), keep the `softtor` side only after `git diff origin/main softtor -- <file>` shows nothing but known fork differences. `git merge --abort` backs out.

### Releasing the fork (`@softtor/nestbun-platform`, `@softtor/nestbun-ws`, `@softtor/nestbun-socket.io`)

`scripts/release.ts` tags the commit on the release branch and pushes branch and tag together, but the tag must sit on the squash commit that lands on `softtor`. `release-softtor.yml` only checks that the tag matches `packages/platform/package.json` and that its commit is an ancestor of `origin/softtor`, so a tag on a commit before the squash is rejected, while a tag on any later `softtor` commit would be published: tag the squash commit itself. So:

```bash
git fetch fork && git checkout -b chore/release-X.Y.Z fork/softtor
RELEASE_REMOTE=fork RELEASE_BRANCH=chore/release-X.Y.Z RELEASE_TAG_PREFIX=softtor-v \
  bun run release <patch|minor|X.Y.Z>        # answer "no" to the push; --dry-run previews
git tag -d softtor-vX.Y.Z
git push fork chore/release-X.Y.Z            # PR "chore(release): softtor-vX.Y.Z", squash-merge
git checkout softtor && git pull fork softtor
git tag softtor-vX.Y.Z && git push fork softtor-vX.Y.Z   # publishes to npm
```

Without the three `RELEASE_*` variables the script targets `origin/main` and the `v` prefix. The publish needs the `NPM_TOKEN` secret of the `@softtor` scope.

## Releasing (maintainers)

```bash
bun run release patch   # or minor, major, or an exact x.y.z; add --dry-run to preview
```

Run it on a clean `main`. It bumps `@nestbun/platform` and `@nestbun/create` to the same version, runs the build and tests, commits, tags `vX.Y.Z` and asks before pushing. The pushed tag triggers `release.yml`, which publishes to npm and creates the GitHub release.
