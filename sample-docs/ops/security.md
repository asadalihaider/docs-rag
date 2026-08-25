---
title: Security
description: Tokens, scopes, RBAC, TLS, worker isolation and audit logging.
tags: [security, rbac, tls, tokens, audit]
sidebar_position: 18
---

# Security

## Tokens and scopes

Larkspur authenticates with opaque bearer tokens prefixed `lk_tok_`. Tokens are
stored as SHA-256 hashes; the plaintext is shown exactly once, at creation.

| Scope | Grants |
| --- | --- |
| `viewer` | Read jobs, runs and logs |
| `apply` | `viewer` plus create, update and delete jobs |
| `operator` | `apply` plus trigger, cancel, pause and resume runs |
| `worker` | Lease, renew and complete runs. Nothing else. |
| `admin` | Everything, including token and role management |

Scopes are not hierarchical in the implementation — each token carries an explicit
set — but the table above is how they are conventionally combined.

The `worker` scope is deliberately narrow: a compromised worker token cannot read
another job's logs, list jobs, or create tokens. Issue worker tokens per pool, not
per installation:

```bash
lark auth token create --name pool-analytics --scope worker --expires 90d
```

`--expires` is required. There is no non-expiring token; the maximum is 365 days.

## Rotating a token

Tokens overlap, so rotation needs no downtime:

1. Create the replacement.
2. Roll it out to the consumer.
3. `lark auth token list` and confirm the old token's `lastUsedAt` has stopped
   advancing.
4. `lark auth token revoke <id>`.

Revocation takes effect within `server.tokenCacheTtl` (default `30s`).

## TLS

Set `server.tls.certFile` and `server.tls.keyFile` to serve HTTPS. Setting
`server.tls.clientCaFile` additionally requires workers to present a client
certificate signed by that CA — mutual TLS on top of bearer tokens.

```yaml
server:
  tls:
    certFile: /etc/larkspur/tls/server.crt
    keyFile: /etc/larkspur/tls/server.key
    clientCaFile: /etc/larkspur/tls/worker-ca.crt
```

Larkspur does not terminate ACME or renew certificates. Rotate them on disk and
send `SIGHUP`; the server reloads the keypair without dropping connections.

## Worker isolation

This is the part that deserves the most thought.

A worker executing `run.image` jobs through the host Docker socket has
root-equivalent access to that host. Any job that can be scheduled can escape to
the host. If your jobs are not all equally trusted, do not use the Docker socket.

The alternatives, in increasing order of isolation:

| Mode | Isolation | Notes |
| --- | --- | --- |
| Docker socket | None from the host | Simplest; only for uniformly trusted jobs |
| Rootless Podman | User namespace | Set `worker.runtime: podman`; no socket mount |
| Kubernetes executor | Pod per run | Set `worker.runtime: kubernetes`; jobs get their own pod, service account and limits |
| Dedicated worker pools | Host-level | Combine `worker.labels` with `workerSelector` to pin untrusted jobs to isolated hosts |

`command` jobs run directly inside the worker process's own container and are
confined by whatever confines the worker.

## Secrets

Secret values are never persisted by Larkspur — manifests hold references, workers
resolve them at run start, and resolved values live only in memory for the
lifetime of the run. See [Secrets](../guides/secrets.md).

The worker scrubs known secret values from captured stdout and stderr, replacing
them with `«redacted»`. Treat that as a safety net, not a control: a job that
transforms a secret before printing it defeats it.

## Audit log

Every mutating API call is written to an append-only audit table and mirrored to
the structured log with `audit: true`:

```json
{"ts":"2026-03-10T09:14:22Z","level":"info","msg":"audit","audit":true,"actor":"user:aria@acme.dev","action":"job.update","target":"nightly-report","result":"ok","ip":"10.2.0.14"}
```

Reads are not audited by default — the volume swamps the signal. Set
`server.audit.includeReads: true` if a compliance regime requires it.

Audit rows follow `retention.auditDays` (default `365`) which is independent of
run history retention.

## Reporting a vulnerability

Email `security@larkspur.dev` with a description and reproduction. Do not open a
public issue. Larkspur ships security fixes as patch releases to the two most
recent minor versions.
