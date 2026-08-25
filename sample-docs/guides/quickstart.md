---
title: Quickstart
description: Define, apply and run your first job.
tags: [quickstart, tutorial]
sidebar_position: 3
---

# Quickstart

This walks through a working job in about five minutes. It assumes you have the
`lark` CLI installed and a control plane reachable — see
[Installation](installation.md) if not.

## 1. Point the CLI at a server

```bash
export LARKSPUR_SERVER_URL="https://larkspur.internal:7842"
lark auth login
```

`lark auth login` opens a browser for the device flow and stores the resulting
token in `~/.config/larkspur/credentials.json` with mode `0600`. In CI, skip the
browser and set `LARKSPUR_API_TOKEN` directly.

## 2. Write a job manifest

Create `report.yaml`:

```yaml
apiVersion: larkspur/v2
kind: Job
metadata:
  name: nightly-report
  labels:
    team: analytics
spec:
  schedule:
    cron: "0 3 * * *"
    timezone: Europe/Berlin
  timeout: 30m
  retry:
    maxAttempts: 3
    strategy: exponential
  run:
    image: ghcr.io/acme/reporting:1.8.0
    command: ["/app/report", "--window", "24h"]
    env:
      REPORT_FORMAT: parquet
```

Every field is documented in the
[job manifest reference](../reference/job-manifest.md).

## 3. Validate before applying

```bash
lark validate report.yaml
```

`validate` runs the same schema check the server does, offline. It catches the
most common mistake — a six-field cron expression copied from a system crontab,
which Larkspur rejects because it uses five-field cron with no seconds column.

## 4. Apply it

```bash
$ lark apply -f report.yaml
job.larkspur/nightly-report created
```

`apply` is declarative and idempotent: re-applying an unchanged manifest is a
no-op and reports `unchanged`. Applying a manifest whose `metadata.name` already
exists updates that job in place; it never creates a duplicate.

## 5. Trigger a run without waiting for the schedule

```bash
$ lark run nightly-report --wait
run 01HQ9F3K2M queued
run 01HQ9F3K2M running on worker-a3f
run 01HQ9F3K2M succeeded in 41.2s
```

`--wait` streams state transitions until the run reaches a terminal state and
exits with the run's exit code, which makes it usable as a CI step.

## 6. Look at what happened

```bash
lark logs 01HQ9F3K2M          # logs for one run
lark runs --job nightly-report --limit 20
lark describe job nightly-report
```

## 7. Pause it

```bash
lark pause nightly-report
lark resume nightly-report
```

Pausing stops new runs being materialised. Runs already in flight are unaffected;
use `lark cancel <run-id>` to stop those.

## Next steps

- [Configuration](configuration.md) — stop typing `--server-url` every time
- [Scheduling](scheduling.md) — cron syntax, intervals, jitter, catch-up
- [Secrets](secrets.md) — get credentials into a job without baking them in
