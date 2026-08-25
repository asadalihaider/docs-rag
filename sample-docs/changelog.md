---
title: Changelog
description: Release history for Larkspur 2.x.
tags: [changelog, releases, versions]
sidebar_position: 20
---

# Changelog

All notable changes are recorded here. Larkspur follows semantic versioning:
breaking changes only in a major release, additive changes in minors.

## 2.4.1 — 2026-02-27

### Fixed

- Worker no longer leaks a lease when the container runtime returns a nil exit
  status, which could leave a run `running` until its lease expired.
- `lark schedule preview` used the local timezone rather than the job's when the
  job set `schedule.timezone` and the CLI was run with `TZ` set.
- `secrets check` reported success for an `aws-secrets-manager` reference whose
  `key` was absent from the JSON payload.

## 2.4.0 — 2026-02-10

### Added

- `schedule.catchUp` with `none`, `latest` and `all`, plus `schedule.catchUpLimit`
  (default `50`). Previously missed occurrences were always skipped.
- `retry.retryOn` — restrict retries to a list of exit codes.
- `lark support bundle` for collecting diagnostics.
- `larkspur_db_pool_wait_seconds` histogram.

### Changed

- `telemetry.sampleRatio` now always samples failed runs regardless of the ratio.
- `lark runs` defaults to a `24h` look-back instead of `7d`; pass `--since` for
  more.

### Deprecated

- `worker.maxParallel` is now an alias for `worker.concurrency` and warns. It will
  be removed in 3.0.

## 2.3.0 — 2025-11-18

### Added

- Kubernetes executor (`worker.runtime: kubernetes`): one pod per run, with the
  job's `resources` translated to pod limits.
- `server.rateLimit.perTokenPerMinute` (default `600`), returning `LK-7002`. Lease
  endpoints are exempt.
- Audit log with `retention.auditDays` (default `365`).

### Fixed

- `catchUp` runs were materialised newest-first; they are now oldest-first.
- Advisory lock contention between control plane replicas produced spurious
  `LK-5001` errors instead of the informational `LK-5004`.

## 2.2.0 — 2025-09-02

### Added

- `schedule.jitter` for spreading runs that share a schedule.
- `spec.priority` influencing lease order.
- `lark import crontab`.

### Changed

- Default `log.format` changed from `text` to `json`. Set `log.format: text` to
  keep the old behaviour.

## 2.1.0 — 2025-06-24

### Added

- `aws-secrets-manager` secret provider.
- `lark secrets check`.
- `TRACEPARENT` injected into every run's environment.

### Fixed

- Daylight-saving handling: a wall-clock time that occurs twice now runs once, on
  the first occurrence. Previously it ran twice.

## 2.0.0 — 2025-03-11

### Breaking

- The `/v1` API and `apiVersion: larkspur/v1` manifests were removed. Convert with
  `lark migrate manifest v1 v2` from the 1.9 CLI before upgrading.
- `concurrencyPolicy` now defaults to `Forbid`. In 1.x the behaviour was
  equivalent to `Allow`. Jobs that relied on overlapping runs must set it
  explicitly.
- The minimum supported PostgreSQL version is 14, up from 12, because lease
  acquisition moved to `SKIP LOCKED` and run history moved to declarative
  partitioning.
- Cron expressions are strictly five-field. 1.x silently accepted a six-field
  expression and ignored the seconds column.

### Added

- Lease-based execution replacing the 1.x heartbeat model, with `LK-3007` on
  expiry.
- Structured JSON logging with `job`, `run_id` and `attempt` on every record.
- Prometheus metrics on a separate `server.metricsListen` port.

### Removed

- `MAILTO`-style email notification. Alert on `larkspur_runs_total{outcome="failed"}`
  instead.
