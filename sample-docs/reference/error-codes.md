---
title: Error codes
description: Every LK-xxxx error code, what causes it and what to do.
tags: [errors, reference, troubleshooting]
sidebar_position: 14
---

# Error codes

Every error Larkspur returns carries a stable `LK-xxxx` code. The code is stable
across versions; the message text is not, so alert on the code.

## 1xxx — configuration

| Code | Message | Cause and fix |
| --- | --- | --- |
| `LK-1001` | config parse failed | `larkspur.yaml` is not valid YAML. `lark config validate` reports the line. |
| `LK-1002` | unknown configuration key | A typo such as `worker.concurency`. Unknown keys are rejected deliberately. |
| `LK-1003` | invalid duration | A bare number where a duration was expected. Use `30s`, not `30`. |
| `LK-1007` | leaseRenewInterval too large | Must be less than one third of `worker.leaseTtl`. |

## 2xxx — objects

| Code | Message | Cause and fix |
| --- | --- | --- |
| `LK-2003` | job not found | The name does not exist, or it was deleted. `lark runs --job` still works for a job deleted with `--keep-history`. |
| `LK-2004` | run not found | Wrong run id, or the run aged out of `retention.runHistoryDays`. |
| `LK-2006` | job name invalid | Lowercase alphanumerics and `-`, 1–63 characters. |
| `LK-2009` | run already finished | You cancelled a run that reached a terminal state first. Harmless. |

## 3xxx — execution

| Code | Message | Cause and fix |
| --- | --- | --- |
| `LK-3007` | lease expired | The worker did not renew in time — it crashed, was evicted, or lost the network. The run is re-queued and will execute again. Investigate if `larkspur_lease_reclaims_total` is rising. |
| `LK-3011` | attempt timed out | The attempt exceeded `spec.timeout`. Counted as a failure and retried if the policy allows. |
| `LK-3014` | image pull failed | Registry unreachable, image missing, or the worker lacks pull credentials. |
| `LK-3018` | no eligible worker | The job's `workerSelector` matches no registered worker's `worker.labels`. |
| `LK-3021` | run cancelled | A human or `concurrencyPolicy: Replace` cancelled it. |

## 4xxx — auth

| Code | Message | Cause and fix |
| --- | --- | --- |
| `LK-4001` | missing or malformed token | No `Authorization: Bearer` header, or it is not a Larkspur token. |
| `LK-4002` | secret resolution failed | The worker could not read a referenced secret. With Vault, first check the KV v2 `data/` path segment. |
| `LK-4003` | insufficient scope | The token is valid but lacks the scope this endpoint needs. |
| `LK-4005` | token expired | Issue a new one with `lark auth token create`. |
| `LK-4009` | protocol version unsupported | A worker is newer than the control plane. Upgrade the control plane first. |

## 5xxx — infrastructure

| Code | Message | Cause and fix |
| --- | --- | --- |
| `LK-5001` | database unreachable | Postgres is down, the DSN is wrong, or the pool is exhausted. Check `larkspur_db_pool_wait_seconds`. |
| `LK-5002` | migration failed | The database user lacks `CREATE`, or a previous migration was interrupted. |
| `LK-5004` | advisory lock unavailable | Another replica holds the scheduling lock. Informational; not an error to alert on. |

## 6xxx — manifests

| Code | Message | Cause and fix |
| --- | --- | --- |
| `LK-6001` | apiVersion unsupported | Must be `larkspur/v2`. v1 manifests were removed in 2.0. |
| `LK-6004` | manifest validation failed | Schema violation. The `details.field` names the offending path. A six-field cron expression is the most common instance. |
| `LK-6006` | run requires image or command | `spec.run` must set exactly one of the two. |
| `LK-6008` | schedule.cron and schedule.every are mutually exclusive | Pick one. |

## 7xxx — limits

| Code | Message | Cause and fix |
| --- | --- | --- |
| `LK-7002` | rate limited | Over `server.rateLimit.perTokenPerMinute`. Honour `Retry-After`. Lease endpoints are exempt. |
| `LK-7005` | catch-up limit exceeded | `catchUp: all` hit `schedule.catchUpLimit`; older occurrences were dropped. |
| `LK-7009` | payload too large | A manifest or log batch exceeded 1 MiB. |

## Reading a code programmatically

```bash
$ lark describe run 01HQ9F3K2M --output json | jq '.error'
{
  "code": "LK-3011",
  "message": "attempt timed out after 30m",
  "details": { "timeout": "30m", "attempt": 2 }
}
```
