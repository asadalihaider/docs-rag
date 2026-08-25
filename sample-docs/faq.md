---
title: FAQ
description: Frequently asked questions about Larkspur.
tags: [faq, questions]
sidebar_position: 19
---

# FAQ

## Does Larkspur run on Windows?

The `lark` CLI ships a Windows build. The control plane and the worker do not.
The worker relies on process groups, `SIGTERM`/`SIGKILL` semantics and cgroup
accounting that have no clean Windows equivalent, and shipping a subtly different
execution model on one platform is worse than not shipping it. Run the server and
workers on Linux and use the Windows CLI against them.

## Which databases are supported?

PostgreSQL 14 or newer, only. Larkspur depends on `SELECT ... FOR UPDATE SKIP
LOCKED` for lease acquisition and on declarative range partitioning for run
history. There is no MySQL or SQLite backend and none is planned.

## Can jobs run more often than once a minute?

No. The control plane materialises runs on a one-minute tick, so `schedule.every`
has a minimum of `1m` and cron has no seconds field. For sub-minute cadence, run a
long-lived process with an internal loop and let Larkspur supervise it — a job
with no schedule, triggered once, that stays up.

## Is execution exactly-once?

No — at-least-once. A worker that completes a job and dies before reporting will
have that run reclaimed and retried. Jobs must be idempotent; `LARKSPUR_RUN_ID` is
stable across reclaims and is the natural idempotency key.
`concurrencyPolicy: Forbid` prevents overlapping runs of the same job but does not
change the delivery guarantee.

## Is there a web UI?

Yes, served by the control plane at `/ui` when `server.ui.enabled` is `true`
(the default). It is read-mostly: browse jobs and runs, read logs, trigger and
cancel runs. Editing manifests is deliberately CLI- and API-only so that job
definitions stay in version control.

## How do I stop a job permanently without losing its history?

```bash
lark pause nightly-report
```

Or set `spec.enabled: false` in the manifest, which survives re-apply. To remove
the job but keep the rows, `lark delete job nightly-report --keep-history`.

## Why was my run recorded as `skipped`?

The previous run was still going and `concurrencyPolicy` is `Forbid`, which is the
default. Set `Allow` to run them concurrently or `Replace` to cancel the in-flight
run first.

## Can I trigger a job from another job?

There is no built-in dependency mechanism — Larkspur deliberately does not do
DAGs. A job can call `POST /v2/jobs/{name}/runs` with a token carrying the
`operator` scope. If you find yourself building a dependency graph this way, you
want a workflow engine instead.

## What happens to running jobs when I deploy a new worker?

The worker stops leasing new work on `SIGTERM`, finishes in-flight runs, and exits
once they complete or `worker.shutdownGrace` (default `30s`) elapses — whichever
comes first. Set `shutdownGrace` above your longest job's typical duration, and
set the orchestrator's termination grace period above that.

## Does Larkspur phone home?

Once a day it checks for a newer version, sending version, OS and architecture
only. No job names, no manifests, no identifiers. Disable it with
`telemetry.disableUsageReporting: true` or `LARKSPUR_DISABLE_USAGE_REPORTING=1`.

## Why are my job's logs gone but the run is still listed?

`retention.logDays` defaults to 7 and `retention.runHistoryDays` defaults to 30.
Metadata outlives log bodies on purpose — the metadata is cheap, the bodies are
not.

## How do I run the same job against several environments?

One job per environment, with the environment in the name and a label:

```yaml
metadata:
  name: report-nightly-staging
  labels:
    env: staging
```

Then `lark apply -f jobs/staging/ --prune --selector env=staging` keeps that
environment's set exactly in sync.

## Is there a Terraform provider?

Yes, `larkspur/larkspur` in the registry. It wraps the same `/v2` API and is
version-locked to the control plane's minor version.

## What licence is Larkspur under?

Apache 2.0 for the CLI, worker and control plane. The Kubernetes executor and SSO
integrations are part of the commercial distribution.
