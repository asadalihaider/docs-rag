---
title: Migrating from cron
description: Import an existing crontab and understand what changes.
tags: [migration, cron, crontab]
sidebar_position: 9
---

# Migrating from cron

## Import a crontab

```bash
$ lark import crontab /etc/cron.d/analytics --namespace analytics --dry-run
would create job analytics/rollup-hourly     (0 * * * *)
would create job analytics/report-nightly    (0 3 * * *)
skipped line 12: @reboot is not supported
```

Drop `--dry-run` to write the generated manifests to stdout, or pass
`--out jobs/` to write one file per job.

The importer maps each crontab line to a job whose `run.command` is the original
command, executed with `/bin/sh -c`. It does **not** try to containerise anything;
that is a follow-up you do deliberately, job by job.

## What does not translate

| crontab feature | Larkspur |
| --- | --- |
| `@reboot` | Not supported — there is no host boot event |
| Seconds field (6-field cron) | Not supported; minimum granularity is 1 minute |
| `MAILTO=` | Not supported; use failure notifications or alerting on metrics |
| Per-user crontabs | Jobs are namespaced by label, not by OS user |
| Environment lines at the top of the file | Imported into `spec.run.env` |

## Behavioural differences that matter

**Overlap.** `cron` starts a new process whenever the schedule fires, whatever
else is running. Larkspur defaults to `concurrencyPolicy: Forbid`, which skips the
new occurrence while a run is still in flight. If a job genuinely relied on
overlapping — or was protected by its own `flock` — set `concurrencyPolicy: Allow`
during migration and remove the `flock` afterwards.

**Retries.** `cron` never retries. Larkspur retries 3 times by default. A job
that was written assuming a single attempt, and is not idempotent, will behave
differently. Set `retry.maxAttempts: 1` to preserve the old behaviour while you
make it idempotent.

**Output.** `cron` mails stdout. Larkspur captures stdout and stderr into run logs
retained for `retention.logDays`. Nothing is mailed.

**Exit codes.** Both treat non-zero as failure. Larkspur additionally treats a
timeout as failure with a distinct error code, `LK-3011`.

**Timezone.** System `cron` uses the host timezone (or `CRON_TZ`). Larkspur
defaults to **UTC**. This is the single most common cause of "the migrated job
runs at the wrong time" — set `schedule.timezone` explicitly to whatever the host
was using.

## A worked example

Before, in `/etc/cron.d/analytics`:

```
0 3 * * * analytics /usr/local/bin/report --window 24h >> /var/log/report.log 2>&1
```

After:

```yaml
apiVersion: larkspur/v2
kind: Job
metadata:
  name: report-nightly
  labels:
    team: analytics
spec:
  schedule:
    cron: "0 3 * * *"
    timezone: Europe/Berlin   # what the host was set to
  concurrencyPolicy: Forbid
  retry:
    maxAttempts: 1            # match cron until the job is idempotent
  run:
    command: ["/usr/local/bin/report", "--window", "24h"]
```

Note that the redirection is gone: Larkspur captures output itself.

## Running both during migration

Pause the crontab entry rather than deleting it, and use `lark pause` on the
Larkspur job. Run one at a time. Running both is how you find out the job was
never idempotent.
