---
title: Configuration
description: The larkspur.yaml file, search order, and how settings are merged.
tags: [config, yaml, precedence]
sidebar_position: 4
---

# Configuration

## Where the config file is read from

Larkspur looks for a configuration file in this order and uses the **first one it
finds**. It does not merge multiple files.

1. The path given to `--config`
2. `$LARKSPUR_CONFIG`
3. `./larkspur.yaml` in the current working directory
4. `$XDG_CONFIG_HOME/larkspur/config.yaml` (falling back to
   `~/.config/larkspur/config.yaml`)
5. `/etc/larkspur/config.yaml`

If none exists, Larkspur starts with built-in defaults. Run
`lark config path` to print which file is actually in use, and
`lark config show --resolved` to print the fully merged configuration with
defaults and environment overrides applied.

## Precedence

Settings are resolved highest-priority first:

1. Command-line flags
2. Environment variables (`LARKSPUR_*`, see
   [Environment variables](../reference/environment-variables.md))
3. The configuration file
4. Built-in defaults

An environment variable always beats the file. This trips people up when a
`LARKSPUR_LOG_LEVEL=debug` left over in a shell profile silently overrides
`log.level: info` in the file — `lark config show --resolved` prints the origin of
every value for exactly this reason.

## A complete example

```yaml
server:
  url: https://larkspur.internal:7842
  listen: 0.0.0.0:7842
  metricsListen: 0.0.0.0:9842

database:
  url: postgres://larkspur@db:5432/larkspur
  maxConnections: 20
  statementTimeout: 30s

worker:
  concurrency: 8
  leaseTtl: 60s
  leaseRenewInterval: 10s
  shutdownGrace: 30s

log:
  level: info
  format: json

retention:
  runHistoryDays: 30
  logDays: 7

telemetry:
  otelEndpoint: https://otel-collector.internal:4317
  serviceName: larkspur
```

Every key is documented in the
[configuration schema reference](../reference/config-schema.md).

## Defaults worth knowing

| Key | Default | Notes |
| --- | --- | --- |
| `server.listen` | `0.0.0.0:7842` | API and lease endpoints |
| `server.metricsListen` | `0.0.0.0:9842` | Prometheus `/metrics` only |
| `database.maxConnections` | `20` | Per control plane replica |
| `worker.concurrency` | `8` | Simultaneous runs per worker |
| `worker.leaseTtl` | `60s` | Reclaimed after this without renewal |
| `log.level` | `info` | `debug`, `info`, `warn`, `error` |
| `log.format` | `json` | `text` is intended for local development |
| `retention.runHistoryDays` | `30` | Older run rows are dropped nightly |

## Per-environment configuration

There is no built-in profile or overlay mechanism. Keep one file per environment
and select it explicitly:

```bash
lark --config config/staging.yaml apply -f jobs/
```

Committing environment-specific files is fine as long as secrets are referenced
rather than embedded — see [Secrets](secrets.md).

## Validating a config file

```bash
lark config validate --config config/staging.yaml
```

Unknown keys are an **error**, not a warning. A typo like `worker.concurency`
fails the check rather than silently falling back to the default, which is the
single most common cause of "I changed the setting and nothing happened".
