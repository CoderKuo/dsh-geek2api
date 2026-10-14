# Repository agent guide

This file governs the entire `dsh-geek2api` repository.

## Repository identity

- Canonical repository: `https://github.com/CoderKuo/dsh-geek2api` (derived from `https://github.com/BaronCyrus/dsh-packycode-api`, MIT)
- Package name: `dsh-geek2api`, distributed as a GitHub Release tarball (`dsh-geek2api-<version>.tgz`); not published to npm
- DSH plugin row: `geek2api`
- Model group display name: `Geek2API`
- Gateway: Geek2API, a sub2api deployment. Entry points: `hk`, `hk2`, `hk3`, `hk4`, `www` `.geek2api.com`. Default endpoints are geek2api.com hosts only.
- LLM provider route key: `geek2api`

## Project boundaries

- This is a permanent DSH profile plugin, not a temporary dynamic Cordis Plugin.
- Host code belongs in `src/index.js` and its sibling modules; browser UI belongs in `src/client.jsx` and is built through the client wrapper in `tsdown.config.mjs`.
- The route is self-contained: the plugin builds its own pi-ai provider, catalog, key ring, and balance reader. It must never require the user to edit `cordis.patch.yml` or `llm-pi-ai` provider YAML.
- Never introduce a silent fallback to another provider, another credential source, or an ambient `GEEK2API_API_KEY`. Only keys the user added through this plugin may authenticate a request.
- The catalog declares protocols and effort levels from vendor documentation. Changing a model's `api`, `baseUrl`, or `thinkingLevelMap` requires a note in `CHANGELOG.md` and a live check.

## Security requirements

- Never print, log, commit, return to the browser, or include in diagnostics any API key. `scripts/live-check.mjs` may read the stored key but must only ever print its masked tail.
- Credentials and balance requests stay host-side. Browser RPC returns only the projections in `src/rpc.js`.
- Balance requests stay bounded by a timeout and configured with `redirect: 'error'`.
- Preserve unrelated DSH plugins, profiles, sessions, settings, and credentials.
- Do not start, stop, or restart DSH without explicit user permission.

## Source and generated files

- Edit `src/`; never hand-edit generated `lib/index.js` or `lib/client.js`.
- `lib/` is tracked and must be regenerated with `pnpm run build` after source changes.
- `.artifacts/` and `node_modules/` are ignored and must never be committed.
- Add or update tests under `tests/` for behavior changes.

## Required validation

```sh
pnpm install
pnpm run check
```

`pnpm run check` must run every test, rebuild both bundles, and produce the versioned tarball in `.artifacts/`.

Live gateway behavior is verified with `node scripts/live-check.mjs` after a build. It consumes a small amount of quota; run it when a change touches the catalog, the provider composition, or the failure classification. Do not claim runtime success from a passing build alone.

## Release authorization

Git tags and GitHub Releases are externally visible: installed copies offer the newest release as an update. Create them only when the user explicitly asks to release and confirms the target version. A request to modify, test, or commit alone is not release authorization.

Never reuse, move, or delete a published tag or release asset. If a released version needs a correction, release a new patch version.

## Release checklist

1. Confirm a clean base and an unused version:

   ```sh
   git status --short --branch
   git ls-remote --exit-code --tags origin refs/tags/v<version>   # must fail
   ```

2. Update `package.json` version and add a `## <version>` section to `CHANGELOG.md` (the release workflow uses that section as the release notes).

3. Validate: `pnpm install --frozen-lockfile && pnpm run check`, and commit the rebuilt `lib/`.

4. Push `main`, then tag and push the tag:

   ```sh
   git tag -a v<version> -m "dsh-geek2api v<version>"
   git push origin v<version>
   ```

   [`.github/workflows/release.yml`](.github/workflows/release.yml) refuses a tag that does not match `package.json`, runs `pnpm run check`, refuses a stale `lib/`, and creates the release with `dsh-geek2api-<version>.tgz` attached. The plugin's update check reads `releases/latest` and installs that asset.

5. Confirm the workflow succeeded and the asset is attached before announcing the release.
