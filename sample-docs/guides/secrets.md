---
title: Secrets
description: Reference secrets from jobs without embedding them in manifests.
tags: [secrets, vault, security]
sidebar_position: 6
---

# Secrets

Larkspur never stores secret *values*. A manifest holds a **reference**; the
worker resolves it at run start and injects the value into the process
environment. Resolved values are held in memory for the lifetime of the run and
are never written to the run history or the logs.

## Referencing a secret

```yaml
spec:
  run:
    image: ghcr.io/acme/reporting:1.8.0
    env:
      REPORT_FORMAT: parquet
    secretRef:
      - name: DATABASE_URL
        from: vault
        path: secret/data/analytics/reporting
        key: dsn
      - name: SLACK_WEBHOOK
        from: env
        key: ACME_SLACK_WEBHOOK
```

`name` is the environment variable the job sees. `from` selects the provider and
the remaining fields are provider-specific.

## Providers

### `env`

Reads from the worker process's own environment. The simplest option and the
right one when your platform already injects secrets into the worker (Kubernetes
`envFrom`, ECS task secrets, systemd `EnvironmentFile`).

```yaml
- name: API_KEY
  from: env
  key: ACME_API_KEY
```

### `file`

Reads a file from the worker filesystem. Intended for mounted secret volumes.

```yaml
- name: TLS_KEY
  from: file
  path: /var/run/secrets/acme/tls.key
```

Trailing newlines are stripped, because virtually every secret mount adds one and
virtually no consumer wants it.

### `vault`

HashiCorp Vault KV v2. The worker authenticates with its own Vault credentials —
Larkspur does not proxy them.

```yaml
- name: DATABASE_URL
  from: vault
  path: secret/data/analytics/reporting
  key: dsn
```

Note the `data/` segment: KV v2 paths include it in the API path even though the
UI hides it. Omitting it is the most common cause of `LK-4002 secret resolution
failed: permission denied`.

### `aws-secrets-manager`

```yaml
- name: DATABASE_URL
  from: aws-secrets-manager
  path: prod/analytics/reporting
  key: dsn          # optional: pick one key out of a JSON secret
```

Without `key`, the entire secret string is injected. With `key`, the secret is
parsed as JSON and that field is extracted.

## Configuring providers

```yaml
secrets:
  vault:
    address: https://vault.internal:8200
    namespace: acme/platform
    authMethod: kubernetes
    role: larkspur-worker
  aws:
    region: eu-central-1
```

## Rotation

Secrets are resolved **at run start**, never cached between runs. A rotated secret
is picked up by the next run with no restart and no re-apply. Long-running jobs
keep the value they started with; if a job runs for hours across a rotation, it
must handle re-authentication itself.

## Checking a reference without running the job

```bash
$ lark secrets check nightly-report
DATABASE_URL   vault                 ok (resolved, 61 bytes)
SLACK_WEBHOOK  env                   ok (resolved, 78 bytes)
```

`secrets check` resolves every reference and reports success, length and
provider — never the value. It is safe to run in CI and is the fastest way to
distinguish "the job is broken" from "the job cannot see its credentials".

## What is redacted

The worker builds a redaction set from every resolved secret value and scrubs
matches from the run's stdout and stderr before shipping them, replacing them
with `«redacted»`. This is a safety net, not a guarantee: a job that base64-encodes
a secret before printing it defeats it. Do not print secrets.
