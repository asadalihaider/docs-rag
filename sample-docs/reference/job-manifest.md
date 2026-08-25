---
title: Job manifest reference
description: Every field of a Larkspur job manifest.
tags: [manifest, yaml, reference, job]
sidebar_position: 12
---

# Job manifest reference

## Top level

```yaml
apiVersion: larkspur/v2   # required, must be exactly this
kind: Job                 # required
metadata: { ... }         # required
spec: { ... }             # required
```

`apiVersion: larkspur/v1` is rejected — v1 manifests were removed in Larkspur 2.0.

## `metadata`

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | string | yes | Unique job name. Lowercase alphanumeric and `-`, 1–63 characters. |
| `labels` | map[string]string | no | Arbitrary key/value labels used by selectors |
| `annotations` | map[string]string | no | Non-identifying metadata, ignored by Larkspur |
| `description` | string | no | Free text, shown by `lark describe` |

Job names are globally unique within an installation. There are no namespaces;
use a label such as `team: analytics` and a name prefix if you need grouping.

## `spec`

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `schedule` | object | — | Omit for a job that is only ever triggered manually |
| `timeout` | duration | `15m` | Per-attempt wall-clock limit |
| `concurrencyPolicy` | enum | `Forbid` | `Allow`, `Forbid` or `Replace` |
| `retry` | object | see below | Retry policy |
| `run` | object | required | What to execute |
| `enabled` | bool | `true` | `false` is equivalent to a persistent pause |
| `priority` | int | `0` | Higher values are leased first |

### `spec.schedule`

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `cron` | string | — | Five-field cron expression |
| `every` | duration | — | Interval, minimum `1m`. Mutually exclusive with `cron` |
| `timezone` | string | `UTC` | IANA zone name |
| `jitter` | duration | `0s` | Random delay in `[0, jitter)` applied per run |
| `catchUp` | enum | `none` | `none`, `latest` or `all` |
| `catchUpLimit` | int | `50` | Maximum runs materialised by `catchUp: all` |
| `startAt` | timestamp | — | Do not schedule before this instant |
| `endAt` | timestamp | — | Do not schedule after this instant |

### `spec.retry`

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `maxAttempts` | int | `3` | Total attempts including the first |
| `strategy` | enum | `exponential` | `exponential`, `fixed` or `none` |
| `initialDelay` | duration | `2s` | Delay before the second attempt |
| `maxDelay` | duration | `5m` | Ceiling for exponential backoff |
| `retryOn` | list[int] | all non-zero | Exit codes that count as retryable |

`maxAttempts: 1` disables retries. `strategy: none` is a synonym.

With `strategy: exponential`, the delay before attempt *n* is
`min(initialDelay × 2^(n-2), maxDelay)`, with full jitter applied — so the second
attempt waits a random duration in `[0, 2s]`, the third in `[0, 4s]`, and so on.

`retryOn` lets a job distinguish "transient" from "will never work":

```yaml
retry:
  maxAttempts: 5
  retryOn: [1, 75]   # do not retry exit code 2 (bad arguments)
```

### `spec.run`

Exactly one of `image` or `command` must be present.

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `image` | string | — | Container image. Executed as a sibling container. |
| `command` | list[string] | — | Executed directly by the worker |
| `args` | list[string] | `[]` | Appended to the image's entrypoint or to `command` |
| `env` | map[string]string | `{}` | Plain environment variables. Never put secrets here. |
| `secretRef` | list[object] | `[]` | Secret references — see [Secrets](../guides/secrets.md) |
| `workdir` | string | image default | Working directory |
| `user` | string | image default | `uid[:gid]` to run as |
| `resources` | object | — | `cpu` and `memory` limits, container jobs only |
| `workerSelector` | map[string]string | `{}` | Only lease onto workers with these labels |

```yaml
spec:
  run:
    image: ghcr.io/acme/reporting:1.8.0
    args: ["--window", "24h"]
    resources:
      cpu: "2"
      memory: 4Gi
    workerSelector:
      pool: analytics
```

`resources` is ignored for `command` jobs — the worker does not create a cgroup
for processes it runs directly.

## Full example

```yaml
apiVersion: larkspur/v2
kind: Job
metadata:
  name: nightly-report
  labels:
    team: analytics
    tier: "1"
  description: Builds the previous day's parquet rollup.
spec:
  schedule:
    cron: "0 3 * * *"
    timezone: Europe/Berlin
    jitter: 120s
    catchUp: latest
  timeout: 30m
  concurrencyPolicy: Forbid
  priority: 10
  retry:
    maxAttempts: 3
    strategy: exponential
    initialDelay: 10s
    maxDelay: 2m
    retryOn: [1, 75]
  run:
    image: ghcr.io/acme/reporting:1.8.0
    args: ["--window", "24h"]
    env:
      REPORT_FORMAT: parquet
    secretRef:
      - name: DATABASE_URL
        from: vault
        path: secret/data/analytics/reporting
        key: dsn
    resources:
      cpu: "2"
      memory: 4Gi
    workerSelector:
      pool: analytics
```

## Validation

Unknown fields are rejected. `lark validate` runs the identical schema offline, so
a manifest that passes `validate` will not be rejected by the server for schema
reasons.
