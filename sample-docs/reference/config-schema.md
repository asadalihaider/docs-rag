---
title: Configuration schema reference
description: Every key of larkspur.yaml, with types and defaults.
tags: [config, schema, reference, yaml]
sidebar_position: 13
---

# Configuration schema reference

This is the full set of keys accepted in `larkspur.yaml`. Unknown keys are a hard
error — see [Configuration](../guides/configuration.md) for search order and
precedence.

## `server`

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `server.url` | string | — | Control plane address used by the CLI and workers |
| `server.listen` | string | `0.0.0.0:7842` | Address the API listens on |
| `server.metricsListen` | string | `0.0.0.0:9842` | Address the Prometheus endpoint listens on |
| `server.externalUrl` | string | `server.url` | Address used in generated links and the device flow |
| `server.requestTimeout` | duration | `30s` | Server-side request deadline |
| `server.rateLimit.perTokenPerMinute` | int | `600` | API rate limit; lease endpoints are exempt |
| `server.tls.certFile` | string | — | PEM certificate; enables TLS when set with `keyFile` |
| `server.tls.keyFile` | string | — | PEM private key |
| `server.tls.clientCaFile` | string | — | Enables mTLS; workers must present a client certificate |

## `database`

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `database.url` | string | — | Postgres DSN. Required for the control plane. |
| `database.maxConnections` | int | `20` | Pool size **per control plane replica** |
| `database.minConnections` | int | `2` | Connections kept open when idle |
| `database.statementTimeout` | duration | `30s` | Applied as `SET statement_timeout` |
| `database.connectTimeout` | duration | `5s` | TCP + handshake deadline |
| `database.sslMode` | enum | `prefer` | `disable`, `prefer`, `require`, `verify-full` |

Total connections to Postgres is `maxConnections × replicas`. With the Postgres
default `max_connections = 100` and four replicas at the default pool size you are
at 80 before anything else connects.

## `worker`

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `worker.concurrency` | int | `8` | Simultaneous runs per worker |
| `worker.leaseTtl` | duration | `60s` | Lease lifetime; reclaimed after this without renewal |
| `worker.leaseRenewInterval` | duration | `10s` | How often a held lease is renewed |
| `worker.pollInterval` | duration | `2s` | Idle poll cadence when no work is available |
| `worker.shutdownGrace` | duration | `30s` | `SIGTERM` → `SIGKILL` delay on cancel or shutdown |
| `worker.labels` | map[string]string | `{}` | Matched against a job's `workerSelector` |
| `worker.workdir` | string | `/tmp/larkspur` | Scratch directory for run working directories |

`leaseRenewInterval` must be less than a third of `leaseTtl`; the server rejects a
configuration where it is not, because a single dropped renewal should not be
enough to lose a lease.

## `log`

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `log.level` | enum | `info` | `debug`, `info`, `warn`, `error` |
| `log.format` | enum | `json` | `json` or `text` |
| `log.includeCaller` | bool | `false` | Adds `file:line` to every record |

## `retention`

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `retention.runHistoryDays` | int | `30` | Run metadata rows older than this are deleted nightly |
| `retention.logDays` | int | `7` | Captured stdout/stderr older than this is deleted |
| `retention.sweepAt` | string | `03:17` | UTC wall-clock time of the nightly sweep |

The sweep drops whole daily partitions rather than issuing `DELETE`, so it is
cheap regardless of volume — but it means retention has one-day granularity.

## `telemetry`

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `telemetry.otelEndpoint` | string | — | OTLP/gRPC collector address; tracing is off when unset |
| `telemetry.serviceName` | string | `larkspur` | `service.name` resource attribute |
| `telemetry.sampleRatio` | float | `0.1` | Head sampling ratio. Failed runs are always sampled. |
| `telemetry.disableUsageReporting` | bool | `false` | Turns off anonymous version-check pings |

## `secrets`

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `secrets.vault.address` | string | — | Vault address |
| `secrets.vault.namespace` | string | — | Vault Enterprise namespace |
| `secrets.vault.authMethod` | enum | `token` | `token`, `kubernetes`, `approle` |
| `secrets.vault.role` | string | — | Role for `kubernetes` and `approle` |
| `secrets.aws.region` | string | — | Region for `aws-secrets-manager` |

## `defaults`

Installation-wide fallbacks applied to jobs that do not set the field themselves.

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `defaults.timeout` | duration | `15m` | Default `spec.timeout` |
| `defaults.retry.maxAttempts` | int | `3` | Default `spec.retry.maxAttempts` |
| `defaults.concurrencyPolicy` | enum | `Forbid` | Default `spec.concurrencyPolicy` |
| `defaults.timezone` | string | `UTC` | Default `spec.schedule.timezone` |

Changing a `defaults.*` key affects jobs that never set the field — including
existing ones, at their next scheduled run. It does not rewrite manifests.

## Duration format

Durations are a number and a unit with no space: `30s`, `5m`, `2h`, `7d`.
Compound forms such as `1h30m` are accepted. A bare number is rejected — `timeout:
30` fails validation rather than guessing seconds.
