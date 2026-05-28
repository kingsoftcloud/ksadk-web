# Security Policy

## Reporting a Vulnerability

Please do not report security vulnerabilities in public issues.

Send reports to `security@kingsoft.com` with:

- Affected version, commit, or build artifact.
- Reproduction steps and expected impact.
- Any proof-of-concept code, logs, or screenshots that are safe to share.
- Whether the report may involve credentials, private endpoints, or customer
  data.

## Scope

In scope:

- Public KSADK Web source.
- Public build scripts for hosted and KSADK static UI bundles.
- Public examples and documentation.

Out of scope for this repository:

- Hosted production Docker, nginx, Helm, image registry, gateway, and runtime
  environment injection details.
- Internal AgentEngine control-plane services.
- Credentials, tokens, or customer data discovered outside the public
  repository.
