---
title: Performance tuning
description: Sizing the pool, the workers and the database for a large installation.
tags: [performance, tuning, scaling, postgres]
sidebar_position: 17
---

# Performance tuning

Larkspur's scaling limits are almost always Postgres, not Larkspur. Tune in this
order: database pool, then worker concurrency, then retention.

## Database connections

`database.maxConnections` (default `20`) is **per control plane replica**. Total
connections are `maxConnections × replicas`, and Postgres defaults to
`max_connections = 100`.

| Replicas | `maxConnections` | Total | Verdict |
| --- | --- | --- | --- |
| 2 | 20 | 40 | Comfortable |
| 4 | 20 | 80 | Tight against a default Postgres |
| 8 | 20 | 160 | Will fail — use PgBouncer or lower the pool |

With more than four replicas, put PgBouncer in transaction pooling mode in front
and set `database.maxConnections` to something small like `5`. Larkspur does not
use session-level state, prepared statement names or `LISTEN`/`NOTIFY`, so
transaction pooling is safe.

Watch `larkspur_db_pool_wait_seconds`. If the p99 is above ~50 ms the pool is the
bottleneck, not the query planner.

## Worker concurrency

`worker.concurrency` (default `8`) is the number of runs one worker executes at
once. Raise it for I/O-bound jobs; leave it low for CPU- or memory-heavy ones.

The interaction that bites: a worker renews its leases on a single loop every
`worker.leaseRenewInterval`. Setting concurrency to 64 on a machine that cannot
schedule that loop promptly causes renewals to slip and runs to be reclaimed
mid-execution — `LK-3007`, and a job that executes twice. If
`larkspur_lease_reclaims_total` rises after a concurrency increase, that is the
cause; lower concurrency or raise `worker.leaseTtl`.

Prefer more workers over higher per-worker concurrency. Workers are stateless and
horizontal scaling has no coordination cost.

## Schedule spreading

Every job that shares a cron expression is materialised on the same one-minute
tick and leased in the same burst. At a few thousand jobs this shows up as a
sawtooth in `larkspur_schedule_lag_seconds` at `:00` of every hour.

```yaml
spec:
  schedule:
    cron: "0 * * * *"
    jitter: 300s
```

Jitter is applied per run and does not drift, so spreading a large fleet across
five minutes costs nothing in schedule accuracy.

## Retention and partitioning

Run history is range-partitioned by day. The nightly sweep at
`retention.sweepAt` (default `03:17` UTC) drops whole partitions rather than
issuing `DELETE`, so retention cost is independent of volume.

| Setting | Default | Effect of raising it |
| --- | --- | --- |
| `retention.runHistoryDays` | `30` | More partitions; planning time grows slowly |
| `retention.logDays` | `7` | Disk usage grows fastest here — log bodies dominate |

Above roughly 90 days of run history, query planning on `lark runs` starts to be
noticeable because of partition pruning overhead. If you need long-term history,
export to a warehouse rather than raising retention.

## Priority

`spec.priority` (default `0`) orders lease acquisition — higher is leased first.
It is not preemptive: a low-priority run already executing is not interrupted.
Use it to make a short critical job jump a queue of long batch jobs, not as a
substitute for capacity.

## Benchmarks from a reference installation

Measured on a single control plane replica, 4 vCPU, with Postgres 16 on
comparable hardware:

| Dimension | Comfortable | Notes |
| --- | --- | --- |
| Jobs | 20,000 | Schedule evaluation is ~O(jobs) per minute |
| Runs materialised per minute | 5,000 | Beyond this, add replicas |
| Concurrent runs | 2,000 | Bounded by workers, not the control plane |
| Lease acquisitions per second | 400 | `SKIP LOCKED`, one round trip per batch |

These are steady-state numbers with `retention.runHistoryDays: 30`. They are a
starting point for capacity planning, not a guarantee.

## What not to tune

`worker.pollInterval` (default `2s`) looks like an obvious latency win. Lowering
it increases database load linearly across every worker and buys at most two
seconds. Leave it alone; use `lark run --wait` when you need an immediate run.
