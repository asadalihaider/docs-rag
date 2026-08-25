---
title: Deploying with Docker Compose
description: A complete local or single-host deployment of the control plane, a worker and Postgres.
tags: [deployment, docker, compose, postgres]
sidebar_position: 7
---

# Deploying with Docker Compose

This is the fastest way to run a complete Larkspur stack on one host. For
production, run the control plane behind a load balancer with at least two
replicas and use managed Postgres.

## Compose file

```yaml
services:
  db:
    image: postgres:16
    environment:
      POSTGRES_USER: larkspur
      POSTGRES_PASSWORD: larkspur
      POSTGRES_DB: larkspur
    volumes:
      - larkspur-db:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U larkspur"]
      interval: 5s
      timeout: 3s
      retries: 20

  server:
    image: ghcr.io/larkspur/server:2.4.1
    depends_on:
      db:
        condition: service_healthy
    environment:
      LARKSPUR_DATABASE_URL: postgres://larkspur:larkspur@db:5432/larkspur
      LARKSPUR_LOG_LEVEL: info
    ports:
      - "7842:7842"
      - "9842:9842"

  worker:
    image: ghcr.io/larkspur/worker:2.4.1
    depends_on:
      - server
    environment:
      LARKSPUR_SERVER_URL: http://server:7842
      LARKSPUR_API_TOKEN: ${WORKER_TOKEN}
      LARKSPUR_WORKER_CONCURRENCY: "4"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock

volumes:
  larkspur-db:
```

## Bootstrapping a worker token

The worker needs a token before it can lease anything, and the server needs to be
up before it can issue one — so the first start is a two-step:

```bash
docker compose up -d db server
docker compose exec server larkspur-server token create \
  --name compose-worker --scope worker --expires 365d
export WORKER_TOKEN="lk_tok_..."
docker compose up -d worker
```

`larkspur-server token create` is the break-glass equivalent of
`lark auth token create`; it talks to the database directly and works before any
user account exists.

## Why the docker socket is mounted

Jobs that specify `run.image` are executed by the worker as sibling containers on
the host daemon, so the worker needs access to the socket. This grants the worker
root-equivalent access to the host — see [Security](../ops/security.md) for the
rootless and Kubernetes alternatives if that is unacceptable in your environment.

Jobs that specify `run.command` without an image execute directly inside the
worker container and do not need the socket.

## Persisting job manifests

The compose stack stores jobs in Postgres, not on disk. Keep manifests in version
control and apply them from CI:

```bash
lark --server-url http://localhost:7842 apply -f jobs/
```

`apply -f` accepts a directory and applies every `.yaml` and `.yml` file in it,
recursively, in lexical order.

## Health checks

```bash
curl -fsS http://localhost:7842/healthz    # liveness: process is up
curl -fsS http://localhost:7842/readyz     # readiness: database reachable
```

Use `/healthz` for liveness and `/readyz` for readiness. `/healthz` deliberately
does not touch the database — a database blip should not cause every control plane
replica to be restarted at once.

## Resource sizing

A control plane replica idles at roughly 60 MB RSS and scales with the number of
jobs, not runs. A worker's memory is dominated by the jobs it executes; with
`worker.concurrency: 8` budget 8 × your largest job plus about 80 MB.
