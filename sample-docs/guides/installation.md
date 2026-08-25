---
title: Installation
description: Install the lark CLI, the control plane and workers.
tags: [install, setup, docker, homebrew]
sidebar_position: 2
---

# Installation

## Prerequisites

The control plane requires **PostgreSQL 14 or newer**. Larkspur uses `SKIP
LOCKED` for lease acquisition and range partitioning for run history, both of
which are unavailable on older versions. Redis is optional and is used only for
the log tailing fan-out described in [Observability](observability.md).

Workers need outbound network access to the control plane on port `7842`, and
nothing else.

## Install the CLI

### Homebrew

```bash
brew install larkspur/tap/lark
lark version
```

### npm

```bash
npm install --global @larkspur/cli
```

The npm package is a thin wrapper that downloads the platform binary on
postinstall. In an air-gapped environment set `LARKSPUR_SKIP_DOWNLOAD=1` and place
the binary on `PATH` yourself.

### Direct download

```bash
curl -fsSL https://get.larkspur.dev/install.sh | sh -s -- --version 2.4.1
```

The installer writes to `/usr/local/bin` by default. Pass `--prefix ~/.local` to
install without `sudo`.

## Verify the install

```bash
$ lark version
lark 2.4.1 (build 2f9c1ad, linux/amd64)
```

If `lark version` prints a version older than the one you installed, an earlier
copy is shadowing it on `PATH`. Run `which -a lark` to find it.

## Run the control plane

The control plane is distributed as a container image:

```bash
docker run --rm \
  -e LARKSPUR_DATABASE_URL="postgres://larkspur:secret@db:5432/larkspur" \
  -p 7842:7842 \
  ghcr.io/larkspur/server:2.4.1
```

On first start the server applies its own schema migrations and exits non-zero if
the database user lacks `CREATE` on the target schema. To run migrations
separately — for example in a deployment job — use:

```bash
larkspur-server migrate --database-url "$LARKSPUR_DATABASE_URL"
```

Migrations are forward-only and idempotent. There is no `down` migration; roll
back by restoring a snapshot.

## Run a worker

```bash
docker run --rm \
  -e LARKSPUR_SERVER_URL="https://larkspur.internal:7842" \
  -e LARKSPUR_API_TOKEN="$WORKER_TOKEN" \
  ghcr.io/larkspur/worker:2.4.1
```

A worker needs a token with the `worker` scope. Create one with:

```bash
lark auth token create --name worker-pool-a --scope worker --expires 90d
```

## Upgrading

Upgrade the control plane before the workers. Workers speak a versioned lease
protocol and a worker one minor version ahead of the control plane will be
rejected with `LK-4009 protocol version unsupported`. The reverse — an older
worker against a newer control plane — is supported for one minor version.

## Uninstall

```bash
brew uninstall lark          # Homebrew
npm uninstall -g @larkspur/cli
rm -f /usr/local/bin/lark    # direct download
```

Uninstalling the CLI does not remove `~/.config/larkspur/`. Delete that directory
to remove cached credentials.
