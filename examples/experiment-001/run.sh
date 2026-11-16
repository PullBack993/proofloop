#!/usr/bin/env bash
# Experiment 001 — SMOKE TEST ONLY.
# One application, one critical workflow. A known defect is rebuilt in an isolated copy, the
# workflow is captured before the faulty change, the change is reapplied, the same probes run
# again, and the report must name the unintended behaviour with a reproduction. Clean changes
# are then verified to count false alarms.
#
# The defect here is seeded, so this proves the pipeline works, not that ProofLoop finds bugs it
# was not built for. The real gate is the same procedure on historical bugs from your own
# repository (see docs/experiment-001.md and docs/phase-0-bug-log.md).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
CLI="node $ROOT/dist/src/cli.js"
WORK="${WORK:-$(mktemp -d -t proofloop-exp001)}"
export PROOFLOOP_HOME="$WORK/proofloop-home"
REPO="$WORK/repo"
OUT="$WORK/out"
mkdir -p "$REPO" "$OUT"
git_() { git -C "$REPO" -c user.email=experiment@example.invalid -c user.name="experiment 001" "$@"; }

echo "== Experiment 001 in $WORK"
cp -R "$ROOT/examples/loads-app/." "$REPO/"
git_ init -q -b main
git_ add -A
git_ commit -qm "v1: load assignment flow"
BASE=$(git_ rev-parse HEAD)

variant() { # name, message
  git_ checkout -q -b "$1" "$BASE"
  cp -R "$HERE/variants/$1/." "$REPO/"
  git_ add -A
  git_ commit -qm "$2"
  git_ rev-parse HEAD
}
DEFECT=$(variant defect "Add pagination to GET /api/loads")
REFACTOR=$(variant refactor "Refactor load domain module (no behaviour change)")
FEATURE=$(variant feature "Expose driverName on loads")
git_ checkout -q main

cd "$REPO"
echo "== Phase 0 limits (from config): $(node -e 'const c=require("./.proofloop/config.json");console.log(JSON.stringify(c.limits))')"
echo "== Freeze control files"
$CLI freeze --by "experiment 001" --note "initial contract"

echo "== Noise: two runs on unchanged code"
set +e
$CLI noise --ref "$BASE" > "$OUT/noise.md"; NOISE_EXIT=$?
set -e
grep -m1 "False alarms" "$OUT/noise.md" || true

echo "== Baseline before the faulty change"
$CLI snapshot --ref "$BASE" --label baseline > "$OUT/baseline.id"

run_verify() { # name, ref
  set +e
  $CLI verify --ref "$2" --json --label "$1" > "$OUT/$1.json" 2> "$OUT/$1.log"
  local code=$?
  set -e
  node -e '
    const r = require(process.argv[1]);
    const un = r.differences.filter(d => d.class === "unintended");
    console.log(`   ${process.argv[2].padEnd(9)} ${r.decision.padEnd(8)} unintended=${un.length} intended=${r.differences.filter(d=>d.class==="intended").length} flaky=${r.differences.filter(d=>d.class==="flaky").length} unknown=${r.differences.filter(d=>d.class==="unknown").length}  statuses=${r.requirements.map(q=>q.id+":"+q.status).join(" ")}`);
  ' "$OUT/$1.json" "$1"
  $CLI report "$(node -e 'console.log(require(process.argv[1]).runId)' "$OUT/$1.json")" > "$OUT/$1.md"
  return $code
}

echo "== Reapply the faulty change and run the same probes"
run_verify defect "$DEFECT" || true

echo "== Clean change 1: pure refactor"
run_verify refactor "$REFACTOR" || true

echo "== Clean change 2: intended feature, with a change claim approved before the diff"
node -e '
  const fs = require("fs"); const f = ".proofloop/contract.json"; const c = JSON.parse(fs.readFileSync(f, "utf8"));
  c.claims = [
    { id: "C1", text: "Load list exposes the assigned driver name", probe: "*", path: "$.body[*].driverName", change: "added", approved: true },
    { id: "C2", text: "Single load exposes the assigned driver name", probe: "*", path: "$.body.driverName", change: "added", approved: true }
  ];
  fs.writeFileSync(f, JSON.stringify(c, null, 2));'
$CLI freeze --by "experiment 001" --note "claims for driverName"
run_verify feature "$FEATURE" || true

echo "== Learning from a correction: the human turns the miss into a permanent check"
DEFECT_RUN=$(node -e 'console.log(require(process.argv[1]).runId)' "$OUT/defect.json")
$CLI correct --run "$DEFECT_RUN" \
  --what "GET /api/loads without paging parameters must return every load" \
  --where "GET /api/loads" --probe gen.get.api.loads --path '$.body[*]' --op count --value 8 \
  --miss-reason no-oracle \
  --rule "When adding pagination, keep the unpaged default response unchanged." \
  --pattern "Every list endpoint keeps returning all rows by default after paging is added"
run_verify defect-again "$DEFECT" || true
run_verify refactor-again "$REFACTOR" || true

echo
echo "== Success criteria"
node - "$OUT" "$NOISE_EXIT" <<'EOF'
const [out, noiseExit] = process.argv.slice(2);
const r = (n) => require(`${out}/${n}.json`);
const defect = r('defect'), refactor = r('refactor'), feature = r('feature'), again = r('defect-again'), refAgain = r('refactor-again');
const unintended = (x) => x.differences.filter((d) => d.class === 'unintended');
const missing = unintended(defect).filter((d) => d.probeId === 'gen.get.api.loads' && d.change === 'removed');
const crit = [
  ['It detects a meaningful known regression', defect.decision === 'REJECTED' && missing.length === 3,
    `defect REJECTED; ${missing.length} loads missing from GET /api/loads, ${unintended(defect).length} unintended differences in total`],
  ['The finding links to reproducible evidence', unintended(defect).every((d) => (defect.reproductions[d.id] ?? []).length > 0),
    'every unintended difference has a reproduction and evidence hashes'],
  ['Clean changes stay under the false-alarm limit', refactor.decision === 'ACCEPTED' && feature.decision === 'ACCEPTED' && unintended(refactor).length === 0 && unintended(feature).length === 0 && noiseExit === '0',
    `noise exit ${noiseExit}; refactor ${refactor.decision} (${unintended(refactor).length} false alarms); feature ${feature.decision} (${unintended(feature).length} false alarms, ${feature.differences.filter((d) => d.class === 'intended').length} claimed)`],
  ['It needs no control over the coding agent', true, 'verification ran on Git commits only'],
  ['A correction becomes a permanent check', again.requirements.some((q) => q.id.startsWith('L') && q.status === 'FAILED') && refAgain.requirements.some((q) => q.id.startsWith('L') && q.status === 'VERIFIED'),
    'lesson check fails on the defect and passes on the refactor'],
];
let ok = true;
for (const [name, pass, detail] of crit) {
  ok &&= pass;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name} — ${detail}`);
}
console.log(`\nReports: ${out}/*.md`);
console.log('Reminder: seeded defect = smoke test only. The gate is held-out historical bugs.');
process.exit(ok ? 0 : 1);
EOF
