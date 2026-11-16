# Experiment 001 — procedure

One real application, one coding agent, one critical workflow. The goal is to detect a real regression an agent missed, without anyone telling the tool where the bug is.

## Smoke test (seeded, not a gate)

`npm run experiment:001` runs the procedure on `examples/loads-app` with a seeded defect: pagination added to `GET /api/loads` with a default page size of 5, so the API and the dispatch board silently drop three loads. It also verifies a pure refactor and an intended feature with an approved change claim, and shows a correction turning into a permanent check. Expected output:

```
PASS  It detects a meaningful known regression
PASS  The finding links to reproducible evidence
PASS  Clean changes stay under the false-alarm limit
PASS  It needs no control over the coding agent
PASS  A correction becomes a permanent check
```

This proves the pipeline works. It does not prove ProofLoop finds bugs it was not built for.

## The real run (historical bug)

Suggested first pilot: a non-production load-assignment flow on Pickup2, with a second independent repository held back for validation.

1. **Pick the bug.** From the phase-0 log ([phase-0-bug-log.md](phase-0-bug-log.md)), take a recent bug that was found by hand after an agent said done, in the chosen workflow. Note the commit before the faulty change (`GOOD`) and the faulty commit (`BAD`).
2. **Isolated copy.** Clone the repository into a scratch folder. Use a test-only database and scoped secrets only (`config.app.passEnv`); never production credentials.
3. **Configure without looking at the bug.** Write `.proofloop/config.json` (clean start, reset, roles, params) and a short list of critical-journey probes for the workflow. Do not write a probe or assertion aimed at the known bug: that would be telling the tool where it is. Record the setup time with `proofloop minutes add --kind setup`.
4. **Freeze and measure noise.**
   ```bash
   proofloop freeze --by "<you>"
   proofloop noise --ref GOOD
   ```
   Fix the environment until clean runs are within `limits.falseAlarmsPerCleanRun`. Any typed rule you add needs an owner and a reason.
5. **Capture before the faulty change.** `proofloop snapshot --ref GOOD`
6. **Reapply the change and run the same probes.** `proofloop verify --ref BAD`
7. **Judge the report.** Does it name the unintended behaviour, with a reproduction that fails on `BAD` and passes on `GOOD`? Record review time with `proofloop minutes add --kind review`.
8. **Count false alarms.** Verify several clean changes from the same period (`proofloop verify --ref <clean-commit>`). Every unintended finding on a clean change is a false alarm: log it with `proofloop correct --false-alarm` and its minutes with `--kind false-alarm`.

## Success criteria (all four)

- It detects a meaningful known regression.
- The finding links to reproducible evidence.
- Clean changes stay under the false-alarm limit written down in phase 0.
- It needs no control over the coding agent.

A pass proves a technical capability on one workflow, not yet a product. If the bug sits in a state no probe visits, that is a coverage gap: record it, with the coverage section of the report, rather than counting it as a failed idea.
