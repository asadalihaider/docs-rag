---
title: Larkspur Overview
description: What Larkspur is, how the pieces fit together, and where to go next.
tags: [overview, architecture]
sidebar_position: 1
---

# Larkspur Overview

Larkspur is a scheduled and event-driven job runner for teams that have outgrown
`cron` but do not want to operate a general-purpose workflow engine. You declare
jobs in YAML manifests, Larkspur stores them in Postgres, and a pool of workers
leases and executes them with retries, timeouts and structured observability.

Larkspur is intentionally small. It does not do DAGs, fan-out/fan-in, or
long-lived human-in-the-loop workflows. If you need those, use a workflow engine.
If you need "run this container every 10 minutes, retry it sensibly, and tell me
when it breaks", Larkspur is built for exactly that.

## Components

| Component | Binary | Purpose |
| --- | --- | --- |
| Control plane | `larkspur-server` | Stores job definitions, computes schedules, hands out run leases, serves the HTTP API |
| Worker | `larkspur-worker` | Leases runs, executes them, streams logs and results back |
| CLI | `lark` | Applies manifests, triggers runs, tails logs, manages tokens |

The control plane is stateless; all durable state lives in Postgres. You can run
as many control plane replicas as you like behind a load balancer — schedule
computation is guarded by an advisory lock, so exactly one replica materialises
runs for a given minute.

## How a run happens

1. The control plane evaluates every enabled job's schedule once per minute and
   inserts a `run` row in state `pending` for anything that is due.
2. A worker polls `POST /v2/leases`, receives a batch of pending runs, and moves
   them to `running` by acquiring a lease with a TTL.
3. The worker executes the job's command or container, renewing the lease every
   10 seconds while it works.
4. On exit the worker reports the outcome; the control plane records `succeeded`
   or `failed` and schedules a retry if the job's retry policy allows one.
5. If a lease expires without renewal — worker crash, network partition, node
   eviction — the control plane reclaims the run and makes it `pending` again.

Because leases are the only mechanism that grants execution rights, a partitioned
worker cannot double-execute a job past its lease TTL. See
[Error codes](reference/error-codes.md) for `LK-3007`, the lease expiry error.

## Execution guarantees

Larkspur gives **at-least-once** execution. A worker that finishes a job and dies
before reporting the result will have that run reclaimed and retried. Jobs must
therefore be idempotent. Setting `concurrencyPolicy: Forbid` (the default)
prevents a second run of the *same job* starting while one is in flight, but it
does not turn at-least-once into exactly-once.

## Where to go next

- [Installation](guides/installation.md) — install the CLI and the server
- [Quickstart](guides/quickstart.md) — a working job in about five minutes
- [Configuration](guides/configuration.md) — `larkspur.yaml` and precedence rules
- [Job manifest reference](reference/job-manifest.md) — every field of a job
- [CLI reference](reference/cli.md) — every command and flag
- [Troubleshooting](ops/troubleshooting.md) — when something is wrong

## Supported platforms

Larkspur runs on Linux (x86-64, arm64) and macOS (Apple silicon and Intel). The
`lark` CLI additionally ships a Windows build; the server and worker do not
support Windows. See the [FAQ](faq.md) for the reasoning.
