---
title: Scheduling
description: Cron expressions, interval schedules, timezones, jitter and catch-up behaviour.
tags: [schedule, cron, timezone, jitter]
sidebar_position: 5
---

# Scheduling

## Cron expressions

Larkspur uses **five-field** cron: minute, hour, day-of-month, month, day-of-week.
There is no seconds field and no year field.

```
┌───────────── minute (0–59)
│ ┌─────────── hour (0–23)
│ │ ┌───────── day of month (1–31)
│ │ │ ┌─────── month (1–12 or JAN–DEC)
│ │ │ │ ┌───── day of week (0–6, Sunday = 0, or SUN–SAT)
│ │ │ │ │
* * * * *
```

Ranges (`1-5`), lists (`1,15`), steps (`*/10`) and named months and days are
supported. `?` is accepted as a synonym for `*` in the day fields for
compatibility with Quartz-style expressions, but has no special meaning.

A six-field expression is rejected at apply time with `LK-6004 manifest
validation failed: schedule.cron must have 5 fields, got 6`. This is the most
common error when moving jobs over from a system crontab that used a seconds
column.

### Shorthand

| Shorthand | Equivalent |
| --- | --- |
| `@hourly` | `0 * * * *` |
| `@daily` | `0 0 * * *` |
| `@weekly` | `0 0 * * 0` |
| `@monthly` | `0 0 1 * *` |
| `@yearly` | `0 0 1 1 *` |

## Interval schedules

For "every N", use `schedule.every` instead of cron:

```yaml
spec:
  schedule:
    every: 5m
```

Accepted units are `s`, `m`, `h` and `d`. The **minimum interval is 1 minute**;
`every: 30s` is rejected. Larkspur materialises runs on a one-minute tick, so
sub-minute scheduling is not something the control plane can express. If you need
second-level cadence, run a long-lived process with an internal loop and let
Larkspur supervise it rather than schedule it.

`schedule.cron` and `schedule.every` are mutually exclusive.

## Timezones

`schedule.timezone` takes an IANA zone name and defaults to `UTC`.

```yaml
spec:
  schedule:
    cron: "30 2 * * *"
    timezone: America/New_York
```

Daylight-saving transitions are handled explicitly:

- **Spring forward** — a wall-clock time that does not exist that day (02:30 in a
  zone that jumps 02:00 → 03:00) runs **once**, at the instant the clock jumps.
- **Fall back** — a wall-clock time that occurs twice runs **once**, on the first
  occurrence.

This is a deliberate choice of "exactly once per nominal day" over "exactly every
24 hours". If you need the latter, use `schedule.every: 24h`, which is
DST-agnostic because it counts elapsed time rather than wall clock.

## Jitter

`schedule.jitter` spreads runs of many jobs that share a schedule:

```yaml
spec:
  schedule:
    cron: "0 * * * *"
    jitter: 90s
```

Each run is delayed by a random duration in `[0, jitter)`, drawn per run. Jitter
is applied after the schedule is computed, so the *next* run time is unaffected —
jitter does not drift. Without jitter, a thousand `@hourly` jobs all hit your
database at `:00`.

## Catch-up after downtime

If the control plane is down when a job was due, behaviour depends on
`schedule.catchUp`:

| Value | Behaviour |
| --- | --- |
| `none` (default) | Missed occurrences are skipped |
| `latest` | One run is materialised for the most recent missed occurrence |
| `all` | Every missed occurrence is materialised, oldest first |

`catchUp: all` is bounded by `schedule.catchUpLimit` (default `50`) so a job that
was paused for a month does not create 43,200 runs on resume.

## Overlap: concurrencyPolicy

When a run is still going and the next occurrence comes due:

| Policy | Behaviour |
| --- | --- |
| `Forbid` (default) | Skip the new occurrence and record it as `skipped` |
| `Allow` | Start it anyway; both runs execute concurrently |
| `Replace` | Cancel the in-flight run, then start the new one |

`Replace` sends `SIGTERM` and waits `worker.shutdownGrace` (default `30s`) before
`SIGKILL`.

## Inspecting a schedule

```bash
$ lark schedule preview nightly-report --count 5
2026-03-11T03:00:00+01:00  (in 7h 12m)
2026-03-12T03:00:00+01:00
2026-03-13T03:00:00+01:00
2026-03-14T03:00:00+01:00
2026-03-15T03:00:00+01:00
```

`schedule preview` evaluates the real scheduler against the job's timezone, so it
is the fastest way to confirm a DST assumption before you find out at 3am.
