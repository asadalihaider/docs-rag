---
title: CLI reference
description: Every lark command, argument and flag.
tags: [cli, reference, commands]
sidebar_position: 10
---

# CLI reference

## Global flags

These apply to every command.

| Flag | Environment variable | Default | Description |
| --- | --- | --- | --- |
| `--config <path>` | `LARKSPUR_CONFIG` | search order | Configuration file to use |
| `--server-url <url>` | `LARKSPUR_SERVER_URL` | from config | Control plane address |
| `--token <token>` | `LARKSPUR_API_TOKEN` | from credentials file | API token |
| `--output <format>` | — | `text` | `text`, `json` or `yaml` |
| `--log-level <level>` | `LARKSPUR_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |
| `--timeout <duration>` | — | `30s` | Per-request timeout |
| `--no-color` | `NO_COLOR` | — | Disable ANSI colour |

## `lark apply`

Create or update jobs from manifests.

```bash
lark apply -f report.yaml
lark apply -f jobs/                 # directory, recursive, lexical order
lark apply -f - < report.yaml       # stdin
```

| Flag | Description |
| --- | --- |
| `-f, --filename <path>` | File, directory or `-` for stdin. Repeatable. |
| `--prune` | Delete jobs with the given `--selector` that are not in the applied set |
| `--selector <k=v>` | Label selector, required with `--prune` |
| `--dry-run` | Validate and print what would change without writing |

`--prune` without `--selector` is refused: pruning across an entire installation
by accident is not a recoverable mistake.

## `lark validate`

Offline schema validation of one or more manifests. Exits non-zero on the first
invalid file. Requires no server connection, which makes it the right thing to run
in a pre-commit hook.

```bash
lark validate jobs/*.yaml
```

## `lark run`

Trigger a run immediately, outside the schedule.

```bash
lark run nightly-report
lark run nightly-report --wait
lark run nightly-report --env DEBUG=1 --arg --window=1h
```

| Flag | Description |
| --- | --- |
| `--wait` | Stream state transitions and exit with the run's exit code |
| `--env <K=V>` | Extra environment variable for this run only. Repeatable. |
| `--arg <value>` | Extra argument appended to `run.command`. Repeatable. |
| `--attempt-timeout <duration>` | Override `spec.timeout` for this run |

## `lark runs`

List runs.

```bash
lark runs --job nightly-report --status failed --limit 20 --output json
```

| Flag | Default | Description |
| --- | --- | --- |
| `--job <name>` | all | Filter by job |
| `--status <status>` | all | `pending`, `running`, `succeeded`, `failed`, `skipped`, `cancelled` |
| `--since <duration>` | `24h` | Look-back window |
| `--limit <n>` | `50` | Maximum rows |

## `lark logs`

```bash
lark logs 01HQ9F3K2M
lark logs 01HQ9F3K2M --follow
lark logs --job nightly-report --follow
lark logs 01HQ9F3K2M --attempt 2
```

`--attempt` selects a specific retry attempt; without it the latest attempt is
shown.

## `lark describe`

Human-readable detail for one object.

```bash
lark describe job nightly-report
lark describe run 01HQ9F3K2M
lark describe worker worker-a3f
```

## `lark pause` / `lark resume`

Stop or restart materialisation of new runs. In-flight runs are unaffected.

```bash
lark pause nightly-report
lark resume nightly-report
```

## `lark cancel`

```bash
lark cancel 01HQ9F3K2M
lark cancel 01HQ9F3K2M --grace 0s     # SIGKILL immediately
```

Sends `SIGTERM`, then `SIGKILL` after `--grace` (default: the worker's
`shutdownGrace`).

## `lark delete`

```bash
lark delete job nightly-report
lark delete job nightly-report --keep-history
```

Deleting a job deletes its run history by default. `--keep-history` retains the
rows and marks the job `deleted`, which is what you want when history feeds a
dashboard.

## `lark schedule preview`

```bash
lark schedule preview nightly-report --count 5
lark schedule preview --cron "0 3 * * *" --timezone Europe/Berlin --count 3
```

Evaluates a schedule without needing the job to exist, which makes it usable to
check an expression before applying it.

## `lark secrets check`

Resolves every secret reference of a job and reports provider and value length,
never the value.

```bash
lark secrets check nightly-report
```

## `lark auth`

```bash
lark auth login                     # device flow, writes credentials file
lark auth logout
lark auth whoami
lark auth token create --name ci --scope apply --expires 30d
lark auth token list
lark auth token revoke lk_tok_01HQ...
```

Scopes are `viewer`, `apply`, `operator`, `worker` and `admin`; see
[Security](../ops/security.md).

## `lark config`

```bash
lark config path                    # which file is in use
lark config show                    # file contents as parsed
lark config show --resolved         # after env and flag overrides, with origins
lark config validate
```

## `lark import crontab`

```bash
lark import crontab /etc/cron.d/analytics --namespace analytics --out jobs/
```

See [Migrating from cron](../guides/migrating-from-cron.md).

## `lark version`

```bash
$ lark version --output json
{"version":"2.4.1","commit":"2f9c1ad","platform":"linux/amd64","serverVersion":"2.4.1"}
```

`serverVersion` is omitted when no server is reachable.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Success |
| `1` | Generic failure |
| `2` | Usage error — bad flag or argument |
| `3` | Validation error in a manifest or config file |
| `4` | Authentication or authorisation failure |
| `5` | Server unreachable |
| `n` | With `lark run --wait`, the run's own exit code |
