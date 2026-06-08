# KSADK Web

KSADK Web is the shared Web UI source for AgentEngine hosted UI and
the KSADK embedded static UI.

## Consumers

- `kingsoftcloud/ksadk-python` consumes the GitHub Release tarball and copies
  `dist-ksadk` into `ksadk/server/static`.
- `agentengine-hosted-ui` consumes the GitHub Release tarball as an npm
  dependency and keeps private deployment shell files such as Docker, nginx,
  Helm, image tags, and runtime environment injection outside this repository.

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

`v0.2.0` exposes these stable entrypoints:

- `@kingsoftcloud/ksadk-web/components`
- `@kingsoftcloud/ksadk-web/runtime`
- `@kingsoftcloud/ksadk-web/capabilities`
- `@kingsoftcloud/ksadk-web/styles`
- `@kingsoftcloud/ksadk-web/types`

Hosted UI should import the shared shell from the package and keep private
auth, routing, feature flags, Docker, nginx, and Helm logic in its own repo.

## Release Contract

Consumers should record the KSADK Web tag and tarball URL they build from.
KSADK release notes must mention the KSADK Web release used to generate
`ksadk/server/static`.

Release `v0.2.0` is expected to attach:

- `kingsoftcloud-ksadk-web-0.2.0.tgz`
- a checksum file for that tarball
