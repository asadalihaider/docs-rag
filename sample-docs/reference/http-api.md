---
title: HTTP API reference
description: The v2 REST API — endpoints, authentication, pagination and errors.
tags: [api, http, rest, reference]
sidebar_position: 11
---

# HTTP API reference

Base path: `/v2`. All request and response bodies are JSON. All timestamps are
RFC 3339 in UTC.

## Authentication

Every endpoint except `/healthz` and `/readyz` requires a bearer token:

```http
Authorization: Bearer lk_tok_01HQ9F3K2MZX...
```

A missing or malformed token returns `401` with error code `LK-4001`. A valid
token without the required scope returns `403` with `LK-4003`.

## Jobs

### `GET /v2/jobs`

List jobs.

| Query parameter | Default | Description |
| --- | --- | --- |
| `selector` | — | Label selector, e.g. `team=analytics` |
| `limit` | `50` | Page size, maximum `200` |
| `cursor` | — | Opaque cursor from the previous page |

```json
{
  "items": [
    { "name": "nightly-report", "paused": false, "schedule": { "cron": "0 3 * * *", "timezone": "Europe/Berlin" } }
  ],
  "nextCursor": "eyJvIjoxMDB9"
}
```

Pagination is cursor-based; there is no offset parameter. `nextCursor` is absent
on the last page.

### `POST /v2/jobs`

Create or replace a job. The body is the manifest as JSON — the same structure as
the YAML, since YAML is parsed to JSON before validation.

Returns `201` on create, `200` on replace, `422` with `LK-6004` on a manifest that
fails validation.

### `GET /v2/jobs/{name}`

Returns the job, its resolved schedule, and its last five runs.

### `DELETE /v2/jobs/{name}`

| Query parameter | Default | Description |
| --- | --- | --- |
| `keepHistory` | `false` | Retain run rows and mark the job deleted |

Returns `204`.

### `POST /v2/jobs/{name}/pause` and `/resume`

Returns `200` with the updated job. Both are idempotent.

## Runs

### `POST /v2/jobs/{name}/runs`

Trigger a run outside the schedule.

```json
{
  "env": { "DEBUG": "1" },
  "args": ["--window=1h"],
  "attemptTimeout": "10m"
}
```

Returns `202` with the created run. The run is `pending` until a worker leases it.

### `GET /v2/runs/{id}`

```json
{
  "id": "01HQ9F3K2M",
  "job": "nightly-report",
  "status": "succeeded",
  "attempt": 1,
  "exitCode": 0,
  "startedAt": "2026-03-10T02:00:03Z",
  "finishedAt": "2026-03-10T02:00:44Z",
  "worker": "worker-a3f"
}
```

### `GET /v2/runs`

Same filters as `lark runs`: `job`, `status`, `since`, `limit`, `cursor`.

### `POST /v2/runs/{id}/cancel`

```json
{ "grace": "30s" }
```

Returns `202`. Cancelling a run that has already finished returns `409` with
`LK-2009`.

### `GET /v2/runs/{id}/logs`

Returns `text/plain` by default. Pass `Accept: text/event-stream` to follow:

```http
GET /v2/runs/01HQ9F3K2M/logs?follow=true
Accept: text/event-stream
```

Each SSE event carries one log line with `stream` (`stdout` or `stderr`) and `ts`.
The stream ends with an `event: end` when the run reaches a terminal state.

## Leases (worker protocol)

These endpoints require the `worker` scope and are not intended for general use.

### `POST /v2/leases`

```json
{ "workerId": "worker-a3f", "capacity": 4, "labels": ["gpu"] }
```

Returns up to `capacity` leased runs, each with a `leaseId` and `expiresAt`.

### `POST /v2/leases/{leaseId}/renew`

Must be called before `expiresAt` or the run is reclaimed and re-queued.
Renewing an expired lease returns `409` with `LK-3007`.

### `POST /v2/leases/{leaseId}/complete`

```json
{ "exitCode": 0, "outcome": "succeeded" }
```

## Errors

Every error response has the same shape:

```json
{
  "error": {
    "code": "LK-6004",
    "message": "manifest validation failed: schedule.cron must have 5 fields, got 6",
    "details": { "field": "spec.schedule.cron" }
  }
}
```

See [Error codes](error-codes.md) for the full list.

## Rate limits

The API allows 600 requests per minute per token by default, configurable with
`server.rateLimit.perTokenPerMinute`. Exceeding it returns `429` with `LK-7002`
and a `Retry-After` header in seconds. Lease endpoints are exempt — throttling
workers would cause the exact outage the limit exists to prevent.

## Versioning

The `/v2` prefix is the API version. Additive changes (new fields, new optional
parameters) happen within a version; removals and semantic changes require a new
prefix. `/v1` was removed in Larkspur 2.0.
