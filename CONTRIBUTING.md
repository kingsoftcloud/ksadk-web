# Contributing

Thanks for helping improve KSADK Web.

## Development Setup

```bash
git clone https://github.com/kingsoftcloud/ksadk-web.git
cd ksadk-web
npm ci
```

## Local Checks

```bash
npm test
npm run build:ksadk
npm run build:hosted
```

Keep hosted deployment shell files, Dockerfiles, Helm charts, private endpoints,
customer screenshots, and generated bundles out of this repository. Consumer
repositories should reference a reviewed KSADK Web tag or commit.

Do not push, publish, or create a release before maintainer review.
