# KSADK Web

KSADK Web is the shared Web UI source for AgentEngine hosted UI and
the KSADK embedded static UI.

## Consumers

- `kingsoftcloud/ksadk-python` consumes `@kingsoftcloud/ksadk-web@latest` by
  default and copies `dist-ksadk` into `ksadk/server/static`.
- `agentengine-hosted-ui` consumes `@kingsoftcloud/ksadk-web@latest` by default
  and keeps private deployment shell files such as Docker, nginx, Helm, image
  tags, and runtime environment injection outside this repository.

## Public Demo

The GitHub Pages demo is published from the reviewed `build:ksadk` output:

https://kingsoftcloud.github.io/ksadk-web/

## Development

```bash
npm ci
npm run dev
npm test
```

## Builds

```bash
npm run build:ksadk
npm run build:hosted
npm run build:lib
npm run build:all
```

`build:ksadk` uses relative assets for the SDK embedded UI. `build:hosted`
uses the `/chat/` base path for the hosted UI bundle. `build:lib` emits the
package entrypoints under `dist-lib`.

## Package Exports

The npm package exposes these stable entrypoints:

- `@kingsoftcloud/ksadk-web/components`
- `@kingsoftcloud/ksadk-web/runtime`
- `@kingsoftcloud/ksadk-web/capabilities`
- `@kingsoftcloud/ksadk-web/styles`
- `@kingsoftcloud/ksadk-web/types`

Hosted UI should import the shared shell from the package and keep private
auth, routing, feature flags, Docker, nginx, and Helm logic in its own repo.

## Release Contract

Consumers should record the resolved KSADK Web package version and lockfile
integrity they build from. KSADK release notes must mention the KSADK Web
release used to generate
`ksadk/server/static`.

Npm releases are published by GitHub Actions using npm Trusted Publishing.
The workflow is `.github/workflows/publish-npm.yml` and is triggered by a
published GitHub Release or manual `workflow_dispatch`. Do not store npm tokens
in repository secrets for the normal release path.

GitHub Release notes are entered manually and must use normal Markdown, not a
JSON-style escaped string. Do not paste text containing literal `\n` sequences
into the release body. Follow the existing `v0.2.10` / `v0.2.11` structure:

```md
## What's New

- **Area name**: User-facing behavior change.
- **Area name**: User-facing behavior change.

## Full Changelog
https://github.com/kingsoftcloud/ksadk-web/compare/<previous-tag>...<new-tag>
```

Release notes should stay concise and product-facing:

- Use `## What's New` and `## Full Changelog`.
- Prefer short bullets that describe shipped behavior, not CI narration.
- Put verification details in the PR, workflow run, or changelog review notes,
  not in the GitHub Release body.
- Keep the release title in the form `ksadk-web vX.Y.Z`.

Before creating a release or dispatching the workflow, verify the payload:

```bash
npm ci
npm test
node --test tests/*.test.mjs
npm run build:all
npm pack --dry-run --access public
```

The publish workflow checks whether `package.json`'s exact version is already
present on npm. Existing versions are skipped because npm packages are
immutable; publish a new patch version for any package-content change.

Hosted UI and KSADK static sync consume the latest released
`@kingsoftcloud/ksadk-web` package by default. Release builds should record the
resolved package version and lockfile integrity; set an explicit version only
when rollback or release-freeze requires it.
