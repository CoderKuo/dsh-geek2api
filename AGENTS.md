# Repository agent guide

This file governs the entire `dsh-geek2api` repository.

## Repository identity

- Canonical repository: not published yet (derived from `https://github.com/BaronCyrus/dsh-packycode-api`, MIT)
- npm package: `dsh-geek2api`
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

`npm publish`, Git tags, GitHub Releases, and version publication are externally visible and partially irreversible. Execute them only when the user explicitly asks to publish or release and confirms the target version. A request to modify, test, or commit alone is not release authorization.

Never reuse, move, delete, or overwrite a published npm version or Git tag. If a published version needs a correction, create a new patch version.

## Release checklist

1. Synchronize and confirm a clean base:

   ```sh
   git fetch origin --tags --prune
   git status --short --branch
   git log --oneline HEAD..origin/main
   ```

   Fast-forward clean remote changes before editing. Never discard remote changes.

2. Confirm the requested SemVer is unused:

   ```sh
   npm view dsh-geek2api@<version> version --json
   git ls-remote --exit-code --tags origin refs/tags/v<version>
   ```

   For an unused npm version, `npm view` normally returns `E404`. An existing npm version or Git tag requires choosing a new version.

3. Update all release metadata together: `package.json` version, `CHANGELOG.md`, and any version pinned in `README.md` / `README.en.md`.

4. Validate and inspect the exact release artifact:

   ```sh
   pnpm install --frozen-lockfile
   pnpm run check
   npm publish .artifacts/dsh-geek2api-<version>.tgz --access public --dry-run --json
   ```

5. Commit the release and push `main` without force. [`.github/workflows/publish.yml`](.github/workflows/publish.yml) must already be on the commit that will be tagged. Do not push the tag in this step.

6. Confirm the package has a GitHub Actions trusted publisher before pushing the tag: repository `<owner>/dsh-geek2api`, workflow filename `publish.yml`, environment empty. Never request that a token, password, or one-time code be pasted into chat.

7. Create the annotated tag and push it. That push publishes with GitHub OIDC. Do not run `npm publish` locally for a release. A local publish cannot attach provenance. Do not set `NODE_AUTH_TOKEN` or a setup-node `registry-url` in the publish workflow; npm treats either as token auth and skips OIDC.

   ```sh
   git tag -a v<version> -m "dsh-geek2api v<version>"
   git push origin v<version>
   ```

   `workflow_dispatch` on the same workflow only prints the OIDC identity npm will match. It does not publish.

8. Confirm the publish workflow succeeded for that tag before declaring the release public. On an OIDC `package not found` error, fix the trusted publisher and re-run the same workflow. Do not move the tag. If the tagged tree itself must change, publish a new patch version.
