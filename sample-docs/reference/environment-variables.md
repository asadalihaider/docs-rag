---
title: Environment variables
description: Every LARKSPUR_* variable and the config key it overrides.
tags: [env, environment, reference, config]
sidebar_position: 15
---

# Environment variables

Environment variables override the configuration file and are overridden by
command-line flags. See [Configuration](../guides/configuration.md) for the full
precedence order.

The naming rule is mechanical: uppercase the config path, replace `.` with `_`,
prefix with `LARKSPUR_`. So `worker.leaseTtl` becomes `LARKSPUR_WORKER_LEASE_TTL`.
Camel-case segments are split on the case boundary.

## Common

| Variable | Config key | Default | Notes |
| --- | --- | --- | --- |
| `LARKSPUR_CONFIG` | — | — | Path to the configuration file |
| `LARKSPUR_SERVER_URL` | `server.url` | — | Used by the CLI and workers |
| `LARKSPUR_API_TOKEN` | — | — | Bearer token; bypasses the credentials file |
| `LARKSPUR_LOG_LEVEL` | `log.level` | `info` | `debug`, `info`, `warn`, `error` |
| `LARKSPUR_LOG_FORMAT` | `log.format` | `json` | `json` or `text` |
| `NO_COLOR` | — | — | Any value disables ANSI colour in CLI output |

## Control plane

| Variable | Config key | Default |
| --- | --- | --- |
| `LARKSPUR_DATABASE_URL` | `database.url` | — |
| `LARKSPUR_DATABASE_MAX_CONNECTIONS` | `database.maxConnections` | `20` |
| `LARKSPUR_LISTEN` | `server.listen` | `0.0.0.0:7842` |
| `LARKSPUR_METRICS_LISTEN` | `server.metricsListen` | `0.0.0.0:9842` |
| `LARKSPUR_TLS_CERT_FILE` | `server.tls.certFile` | — |
| `LARKSPUR_TLS_KEY_FILE` | `server.tls.keyFile` | — |
| `LARKSPUR_TLS_CLIENT_CA_FILE` | `server.tls.clientCaFile` | — |

## Worker

| Variable | Config key | Default |
| --- | --- | --- |
| `LARKSPUR_WORKER_CONCURRENCY` | `worker.concurrency` | `8` |
| `LARKSPUR_WORKER_LEASE_TTL` | `worker.leaseTtl` | `60s` |
| `LARKSPUR_WORKER_LABELS` | `worker.labels` | — | 
| `LARKSPUR_WORKER_WORKDIR` | `worker.workdir` | `/tmp/larkspur` |

`LARKSPUR_WORKER_LABELS` takes a comma-separated `k=v` list, e.g.
`pool=analytics,gpu=true`, because a map cannot be expressed in a single
environment variable otherwise.

## Telemetry

| Variable | Config key | Default |
| --- | --- | --- |
| `LARKSPUR_OTEL_ENDPOINT` | `telemetry.otelEndpoint` | — |
| `LARKSPUR_OTEL_SERVICE_NAME` | `telemetry.serviceName` | `larkspur` |
| `LARKSPUR_TELEMETRY_SAMPLE_RATIO` | `telemetry.sampleRatio` | `0.1` |
| `LARKSPUR_DISABLE_USAGE_REPORTING` | `telemetry.disableUsageReporting` | `false` |

Setting `LARKSPUR_DISABLE_USAGE_REPORTING=1` stops the daily anonymous version
check. It reports version, OS and architecture only, and never job names.

## Installer-only

| Variable | Effect |
| --- | --- |
| `LARKSPUR_SKIP_DOWNLOAD` | The npm package does not download a binary on postinstall |
| `LARKSPUR_INSTALL_PREFIX` | Install prefix used by `install.sh`; default `/usr/local` |

## Variables Larkspur sets for a job

These are injected into every run's environment and cannot be overridden by
`spec.run.env`:

| Variable | Example | Meaning |
| --- | --- | --- |
| `LARKSPUR_JOB` | `nightly-report` | Job name |
| `LARKSPUR_RUN_ID` | `01HQ9F3K2M` | Run id |
| `LARKSPUR_ATTEMPT` | `2` | 1-based attempt number |
| `LARKSPUR_SCHEDULED_AT` | `2026-03-10T02:00:00Z` | Nominal schedule time, before jitter |
| `TRACEPARENT` | `00-4bf9...-01` | W3C trace context for the run span |

`LARKSPUR_SCHEDULED_AT` is the nominal time, not the actual start time — a job
that computes "yesterday" should derive it from this rather than from the clock,
so a retry an hour later still processes the same window.
