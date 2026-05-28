# KSADK Web

KSADK Web is the shared Web UI source for AgentEngine hosted UI and
the KSADK embedded static UI.

## Consumers

- `kingsoftcloud/ksadk-python` consumes the `build:ksadk` output for
  `ksadk/server/static`.
- `agentengine-hosted-ui` consumes the `build:hosted` output and keeps private
  deployment shell files such as Docker, nginx, Helm, image tags, and runtime
  environment injection outside this repository.

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
npm run build:all
```

`build:ksadk` uses relative assets for the SDK embedded UI. `build:hosted`
uses the `/chat/` base path for the hosted UI bundle.

## Release Contract

Consumers should record the KSADK Web tag or commit they build from. KSADK
release notes must mention the KSADK Web ref used to generate
`ksadk/server/static`.
