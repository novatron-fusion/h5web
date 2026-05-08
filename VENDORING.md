# Vendoring & Internal Fork

This repository is an internal fork of
[silx-kit/h5web](https://github.com/silx-kit/h5web).

## Publish Strategy

Source code keeps the original `@h5web/*` package names to minimize merge
conflicts when syncing from upstream. At publish time, CI automatically renames
packages to `@novatron-fusion/h5web-*` and publishes to GitHub Packages.

| Source name     | Published name                      |
| --------------- | ----------------------------------- |
| `@h5web/app`    | `@novatron-fusion/h5web-app`        |
| `@h5web/lib`    | `@novatron-fusion/h5web-lib`        |
| `@h5web/h5wasm` | `@novatron-fusion/h5web-h5wasm`     |
| `@h5web/shared` | _(not published — private package)_ |

### How it works

The `publish-packages.yml` workflow:

1. Runs `sed` to rename all `@h5web/` references to `@novatron-fusion/h5web-` in
   source and config files (CI-only, never committed).
2. Runs `pnpm install --no-frozen-lockfile` to re-resolve workspace references
   under the new names.
3. Builds packages — the built output contains `@novatron-fusion/h5web-*` import
   paths.
4. Publishes to GitHub Packages via `GITHUB_TOKEN`.

### Triggering a release

Push a version tag:

```bash
git tag v17.0.0
git push origin v17.0.0
```

Beta releases use the `next` npm tag automatically when the version contains
`beta` (e.g. `v17.1.0-beta.1`).

## Consumer Setup

Projects consuming these packages need an `.npmrc`:

```ini
@novatron-fusion:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

Set the `GITHUB_TOKEN` environment variable to a PAT with `read:packages` scope,
then install:

```bash
npm install @novatron-fusion/h5web-app @novatron-fusion/h5web-lib
```

## Syncing from Upstream

```bash
# Add upstream remote (once)
git remote add upstream https://github.com/silx-kit/h5web.git

# Fetch and merge
git fetch upstream
git merge upstream/main
```

Since the source code keeps `@h5web/*` names, merge conflicts are limited to
files that both upstream and this fork have modified (features, config, etc.) —
not every import statement.

## Versioning

Recommended: mirror upstream versions with a suffix to maintain traceability.

```
upstream 17.0.0  →  internal 17.0.0-novatron.1
upstream 17.1.0  →  internal 17.1.0-novatron.1
```

## License

This fork retains the original MIT license. See [LICENSE.md](LICENSE.md).
