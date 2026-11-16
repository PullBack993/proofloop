# Phase 0 — bug log and limits

Write down 10 recent bugs found by hand after an agent said done. Each one becomes a permanent regression check once ProofLoop can reproduce it (`proofloop correct … --probe … --path … --op …`).

## Limits for day 10 (fill in before any measurement)

| Limit | Value | Where it lives |
|---|---|---|
| False alarms per clean run | | `config.limits.falseAlarmsPerCleanRun` |
| Setup time for one repository (minutes) | | `config.limits.setupMinutes` |
| Run time per verify (minutes) | | `config.limits.runMinutes` |

## Chosen stack and workflow

- Repository:
- Stack:
- Critical workflow:
- Clean-start command (test-only database, scoped secrets, no production credentials):

## Bugs

| # | Found on | Repository | Workflow | Good commit | Bad commit | Symptom | Reproduction steps | Category | Reproducible today? | Held out? |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | | | | | | | | | | |
| 2 | | | | | | | | | | |
| 3 | | | | | | | | | | |
| 4 | | | | | | | | | | |
| 5 | | | | | | | | | | |
| 6 | | | | | | | | | | |
| 7 | | | | | | | | | | |
| 8 | | | | | | | | | | |
| 9 | | | | | | | | | | |
| 10 | | | | | | | | | | |

Categories: regression in an untouched caller · edge to another system · authorization · data/state · UI state · business rule · other.

Count the bugs that cannot be reproduced (old commit no longer starts, missing test data). They stay in the counts.
