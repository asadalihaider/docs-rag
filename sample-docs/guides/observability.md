---
title: Observability
description: Metrics, structured logs, traces and alerting.
tags: [metrics, prometheus, logs, tracing, opentelemetry]
sidebar_position: 8
---

# Observability

## Metrics

The control plane and the worker both expose Prometheus metrics on
`server.metricsListen`, which defaults to `0.0.0.0:9842`, at `/metrics`. The
metrics port is separate from the API port so you can expose one and not the
other.

| Metric | Type | Labels | Meaning |
| --- | --- | --- | --- |
| `larkspur_runs_total` | counter | `job`, `outcome` | Runs reaching a terminal state |
| `larkspur_run_duration_seconds` | histogram | `job` | Wall-clock execution time |
| `larkspur_runs_pending` | gauge | — | Runs waiting for a lease |
| `larkspur_lease_reclaims_total` | counter | `reason` | Leases expired and reclaimed |
| `larkspur_schedule_lag_seconds` | gauge | — | Delay between due time and materialisation |
| `larkspur_worker_slots_in_use` | gauge | `worker` | Busy execution slots |
| `larkspur_db_pool_wait_seconds` | histogram | — | Time spent waiting for a database connection |

### The three alerts worth having

`larkspur_schedule_lag_seconds` above 120 for five minutes means the control plane
is not keeping up and jobs are running late.

`rate(larkspur_lease_reclaims_total[15m])` climbing means workers are dying or
being partitioned mid-run; every reclaim is a job that will be executed again.

`larkspur_runs_pending` growing monotonically means you do not have enough worker
capacity for the schedule you have defined.

## Logs

Logs are structured JSON by default (`log.format: json`). Set `log.format: text`
for human-readable local development output.

```json
{"ts":"2026-03-10T02:00:03.114Z","level":"info","msg":"run finished","job":"nightly-report","run_id":"01HQ9F3K2M","outcome":"succeeded","duration_ms":41210,"attempt":1}
```

Every log line emitted while executing a run carries `job`, `run_id` and
`attempt`, so a single `run_id` is enough to reconstruct a run end to end.

Job stdout and stderr are captured separately from Larkspur's own logs and are
retrievable with `lark logs <run-id>`. They are retained for
`retention.logDays` (default 7) which is deliberately shorter than run history
retention (default 30 days) — the metadata is cheap, the log bodies are not.

### Tailing

```bash
lark logs 01HQ9F3K2M --follow
lark logs --job nightly-report --follow    # every run of a job
```

Following across all runs of a job requires Redis to be configured; without it the
control plane can only tail runs on the replica the CLI happens to be connected
to.

## Tracing

Set `telemetry.otelEndpoint` (or `LARKSPUR_OTEL_ENDPOINT`) to an OTLP/gRPC
collector. Larkspur emits one trace per run:

```
larkspur.run
├── larkspur.lease.acquire
├── larkspur.secrets.resolve
├── larkspur.exec
└── larkspur.report
```

The trace context is injected into the job's environment as `TRACEPARENT`, so a
job that is itself instrumented becomes a child span of its own run.

Sampling is head-based and controlled by `telemetry.sampleRatio` (default `0.1`).
Failed runs are **always** sampled regardless of the ratio.

## Correlating a failure

1. Alert fires on `larkspur_runs_total{outcome="failed"}`.
2. `lark runs --job nightly-report --status failed --limit 5` gives run ids.
3. `lark describe run <id>` gives the exit code, attempt number and error code.
4. `lark logs <id>` gives the job's own output.
5. The `TRACEPARENT` in the run's environment links to the job's own spans.
