#!/usr/bin/env bash
# ProofLoop in front of the agent — end-to-end test of the launcher with stand-in agents.
# The stub CLIs (stub-agent.mjs) imitate `claude` and `codex`: same arguments, same hook calls.
# Each one first makes the seeded pagination defect, then fixes it once ProofLoop sends the
# findings back. For both agents, headless (`proofloop run`) and interactive (`proofloop claude|codex`):
#   - the baseline is recorded before the agent starts,
#   - edits to the contract and to protected tests are denied by the hooks,
#   - the defect is rejected and the findings reach the agent,
#   - the fix is accepted, and the launcher's exit code says so.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
CLI=(node "$ROOT/dist/src/cli.js")
WORK="${WORK:-$(mktemp -d -t proofloop-agent-loop)}"
export PROOFLOOP_HOME="$WORK/proofloop-home"
REPO="$WORK/repo"
VARIANTS="$WORK/variants"
BIN="$WORK/bin"
export STUB_VARIANTS="$VARIANTS"
mkdir -p "$REPO" "$VARIANTS/base/src" "$BIN"
git_() { git -C "$REPO" -c user.email=agent-loop@example.invalid -c user.name="agent loop" "$@"; }

echo "== Agent loop test in $WORK"
cp -R "$ROOT/examples/loads-app/." "$REPO/"
git_ init -q -b main
git_ add -A
git_ commit -qm "v1: load assignment flow"
cp "$ROOT/examples/loads-app/src/loads.mjs" "$ROOT/examples/loads-app/src/server.mjs" "$VARIANTS/base/src/"
cp -R "$ROOT/examples/experiment-001/variants/defect" "$ROOT/examples/experiment-001/variants/refactor" "$VARIANTS/"
for a in claude codex; do
  printf '#!/bin/sh\nSTUB_AGENT=%s exec node "%s" "$@"\n' "$a" "$HERE/stub-agent.mjs" > "$BIN/$a"
  chmod +x "$BIN/$a"
done

cd "$REPO"
"${CLI[@]}" freeze --by "agent loop test" --note "initial contract" 2>/dev/null

reset_repo() { git_ checkout -q -- . && git_ clean -qfd -e .codex; }
PASS=0
FAIL=0
check() { # description, command...
  local d="$1"; shift
  if "$@"; then echo "PASS  $d"; PASS=$((PASS + 1)); else echo "FAIL  $d"; FAIL=$((FAIL + 1)); fi
}
logq() { node -e "$1" "$STUB_LOG"; }
# Assertions over the stub's JSON-lines log.
denied() { logq "const L=require('fs').readFileSync(process.argv[1],'utf8').trim().split('\n').map(JSON.parse);process.exit(L.some(e=>e.attempt==='$1'&&e.denied===$2)?0:1)"; }
prompt_has() { logq "const L=require('fs').readFileSync(process.argv[1],'utf8').trim().split('\n').map(JSON.parse);const p=L.filter(e=>e.prompt!==undefined).map(e=>e.prompt);process.exit(p.length>=2&&p[1].includes('$1')?0:1)"; }
first_prompt_has() { logq "const L=require('fs').readFileSync(process.argv[1],'utf8').trim().split('\n').map(JSON.parse);const p=L.find(e=>e.prompt!==undefined);process.exit(p&&p.prompt.includes('$1')?0:1)"; }
turn() { logq "const L=require('fs').readFileSync(process.argv[1],'utf8').trim().split('\n').map(JSON.parse);const t=L.find(e=>e.turn===$1);process.exit(t&&t.blocked===$2?0:1)"; }

for AGENT in claude codex; do
  echo
  echo "== $AGENT, headless loop: proofloop run"
  export STUB_LOG="$WORK/$AGENT-run.jsonl"; : > "$STUB_LOG"
  set +e
  "${CLI[@]}" run --agent "$AGENT" --agent-bin "$BIN/$AGENT" --rounds 3 "Add pagination to the loads list" > "$WORK/$AGENT-run.out" 2>&1
  CODE=$?
  set -e
  check "$AGENT run: exit 0 (ACCEPTED)" test "$CODE" -eq 0
  check "$AGENT run: accepted in round 2, after one rejection" grep -q "ACCEPTED after 2 round" "$WORK/$AGENT-run.out"
  check "$AGENT run: round 1 rejected the defect" grep -q "REJECTED" "$WORK/$AGENT-run.out"
  check "$AGENT run: the task carried the frozen contract" first_prompt_has "Frozen acceptance contract"
  check "$AGENT run: findings were sent back to the same session" prompt_has "unintended change"
  check "$AGENT run: contract edit denied" denied .proofloop/contract.json true
  check "$AGENT run: protected test edit denied" denied test/loads.test.mjs true
  check "$AGENT run: app code edit allowed" denied src/loads.mjs false
  reset_repo

  echo "== $AGENT, interactive session: proofloop $AGENT"
  export STUB_LOG="$WORK/$AGENT-interactive.jsonl"; : > "$STUB_LOG"
  set +e
  "${CLI[@]}" "$AGENT" --agent-bin "$BIN/$AGENT" > "$WORK/$AGENT-interactive.out" 2>&1
  CODE=$?
  set -e
  check "$AGENT session: stop gate refused the defect" turn 1 true
  check "$AGENT session: stop gate let the fix through" turn 2 false
  check "$AGENT session: final verification ACCEPTED, exit 0" test "$CODE" -eq 0
  check "$AGENT session: hooks ran (no warning)" bash -c "! grep -q 'hooks did not run' '$WORK/$AGENT-interactive.out'"
  reset_repo
done

echo
echo "== round cap and dirty tree"
export STUB_LOG="$WORK/cap.jsonl"; : > "$STUB_LOG"
set +e
"${CLI[@]}" run --agent claude --agent-bin "$BIN/claude" --rounds 1 "Add pagination" > "$WORK/cap.out" 2>&1; CODE=$?
set -e
check "one round only: REJECTED, exit 1" test "$CODE" -eq 1
reset_repo
export STUB_LOG="$WORK/dirty.jsonl"; : > "$STUB_LOG"
echo "// local edit" >> src/loads.mjs
set +e
"${CLI[@]}" claude --agent-bin "$BIN/claude" > "$WORK/dirty.out" 2>&1; CODE=$?
set -e
check "uncommitted changes: refused before the agent starts (exit 2)" test "$CODE" -eq 2
check "uncommitted changes: the agent never ran" test ! -s "$STUB_LOG"
reset_repo

echo
echo "$PASS passed, $FAIL failed. Logs and reports in $WORK"
test "$FAIL" -eq 0
