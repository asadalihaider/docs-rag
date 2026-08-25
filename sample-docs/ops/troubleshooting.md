---
title: Troubleshooting
description: Symptoms, causes and fixes for the problems that actually happen.
tags: [troubleshooting, debugging, operations]
sidebar_position: 16
---

# Troubleshooting

## A job is stuck in `pending`

A run stays `pending` until a worker leases it. In order of likelihood:

1. **No worker is registered.** Check with `lark describe worker --all`. An empty
   list means no worker has a valid token or none can reach the control plane.
2. **The worker selector matches nothing.** If the job sets
   `spec.run.workerSelector`, a worker must carry all of those labels in
   `worker.labels`. A mismatch surfaces as `LK-3018 no eligible worker`.
3. **Every worker is full.** `larkspur_worker_slots_in_use` equal to
   `worker.concurrency` on every worker means you are capacity-bound, not broken.
4. **`concurrencyPolicy: Forbid` and a run is still going.** The new occurrence is
   recorded as `skipped`, not `pending` — if you see `skipped`, this is why.

```bash
lark describe run <id>          # shows why it has not been leased
lark describe worker --all      # registration, labels, free slots
```

## `LK-5001 database unreachable`

Distinguish "Postgres is down" from "the pool is exhausted", because they look
identical from the outside:

```promql
histogram_quantile(0.99, rate(larkspur_db_pool_wait_seconds_bucket[5m]))
```

A p99 pool wait above a second with Postgres healthy means `database.maxConnections`
is too low, or one replica is holding connections in long transactions. Remember
the total is `maxConnections × replicas` — four replicas at the default 20 is 80
connections against a default `max_connections` of 100.

## Runs execute twice

Larkspur is at-least-once. Two executions of one run means a lease expired and the
run was reclaimed while the original worker was still going. Confirm with:

```bash
lark describe run <id> --output json | jq '.attempts[].error.code'
```

`LK-3007` in that list is the signature. Common causes:

- The job routinely runs longer than `worker.leaseTtl` and the worker is too busy
  to renew — raise `worker.leaseTtl` or lower `worker.concurrency`.
- The worker is being OOM-killed. Check the exit code: `137`.
- Network partitions between the worker and the control plane.

The fix is always the same in the end: make the job idempotent. `LARKSPUR_RUN_ID`
is stable across reclaims and is the natural idempotency key.

## A job runs at the wrong time

Almost always a timezone. `spec.schedule.timezone` defaults to `UTC`, not the host
timezone — the opposite of system `cron`.

```bash
lark schedule preview nightly-report --count 5
```

If the preview matches your expectation but the run does not, check for
`schedule.jitter`, which delays by up to its value.

Around daylight-saving transitions, a wall-clock time that occurs twice runs once,
and a time that does not occur runs once at the jump. Use `schedule.every: 24h` if
you need a fixed 24-hour interval instead.

## `LK-6004 manifest validation failed`

The response's `details.field` names the exact path. The two that come up
constantly:

- `spec.schedule.cron must have 5 fields, got 6` — a seconds column copied from a
  system crontab.
- `unknown field spec.run.envFrom` — Larkspur uses `secretRef`, not `envFrom`.

Run `lark validate` locally; it is the same schema, offline.

## Secrets resolve locally but not on the worker

`lark secrets check` runs on **your** machine with **your** credentials. The worker
has its own. With Vault, the worker authenticates with `secrets.vault.authMethod`
and its own role — a reference that works from your laptop can still fail with
`LK-4002` on the worker.

Check the KV v2 `data/` segment first: `secret/data/analytics/reporting`, not
`secret/analytics/reporting`.

## Logs are empty for a run that clearly printed output

- Log bodies are retained for `retention.logDays` (default 7), which is shorter
  than run history (default 30). An old run legitimately has metadata and no logs.
- A job that writes to a file instead of stdout produces no captured output.
- Output above 1 MiB per batch is rejected with `LK-7009`; very chatty jobs should
  log to a file and ship it themselves.

## The control plane is up but jobs are late

Watch `larkspur_schedule_lag_seconds`. Sustained lag means schedule materialisation
is behind. Causes, in order: a slow database, thousands of jobs on the same
one-minute tick (add `jitter`), or a replica holding the advisory lock while
blocked on a query.

`LK-5004 advisory lock unavailable` on other replicas is normal and expected —
only one replica materialises runs for a given minute.

## Getting a support bundle

```bash
lark support bundle --job nightly-report --since 24h --out bundle.tgz
```

Collects the job manifest, recent runs, worker registrations, resolved
configuration with values redacted, and control plane version. It never includes
secret values or job log bodies.
