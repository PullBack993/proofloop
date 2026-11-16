// Before-and-after report: status per requirement with evidence, every classified difference
// with a reproduction, probe coverage, and what was not verified, as plainly as what passed.
import type { VerifyReport } from './verify.js';
import { fmtJson } from './util.js';

const ICON: Record<string, string> = { VERIFIED: '✅', FAILED: '❌', BLOCKED: '⛔', UNKNOWN: '❔' };

function esc(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

export function renderMarkdown(r: VerifyReport): string {
  const L: string[] = [];
  const un = r.differences.filter((d) => d.class === 'unintended');
  L.push(`# ProofLoop report ${r.runId}`);
  L.push('');
  L.push(`**Decision: ${r.decision}**${r.decision === 'REJECTED' ? ` — ${r.requirements.filter((x) => x.mandatory && x.status !== 'VERIFIED').length} mandatory requirement(s) not verified` : ' — every mandatory requirement is verified on this commit'}`);
  L.push('');
  L.push(`- Baseline: \`${r.baseline.id}\` at \`${r.baseline.commit.slice(0, 10)}\` (${r.baseline.label})`);
  L.push(`- Head: \`${r.head.id}\` at \`${r.head.commit.slice(0, 10)}\`${r.head.dirty ? ` + uncommitted changes (\`${r.head.worktreeDiffHash}\`)` : ''}${r.head.status === 'blocked' ? ` — **BLOCKED: ${r.head.blockedReason}**` : ''}`);
  L.push(`- Control version: v${r.controlVersion} · run time ${(r.durationMs / 1000).toFixed(1)} s`);
  for (const n of r.controlNotes) L.push(`- ⚠️ ${n}`);
  if (r.envDrift.length) L.push(`- ⚠️ Environment drift between baseline and head: ${r.envDrift.join('; ')}`);
  L.push('');

  L.push('## Requirements');
  L.push('');
  L.push('| Status | Id | Requirement | Oracle | Evidence |');
  L.push('|---|---|---|---|---|');
  for (const q of r.requirements) {
    const ev = q.outcomes.map((o) => `${ICON[o.status]} ${o.check}: ${o.detail}${o.preexisting ? ' **(PREEXISTING)**' : ''}`).join('<br>');
    L.push(`| ${ICON[q.status]} ${q.status} | ${q.id}${q.mandatory ? '' : ' (optional)'} | ${esc(q.text)} | ${q.oracle} | ${esc(ev)} |`);
  }
  L.push('');

  L.push(`## Differences (${r.differences.length})`);
  L.push('');
  if (!r.differences.length) L.push('No difference between baseline and head in any probed behaviour.');
  const order = ['unintended', 'unknown', 'flaky', 'environment-drift', 'intended'] as const;
  for (const cls of order) {
    const ds = r.differences.filter((d) => d.class === cls);
    if (!ds.length) continue;
    L.push(`### ${cls} (${ds.length})`);
    L.push('');
    for (const d of ds) {
      L.push(`- **${d.id}** \`${d.probeId}\` \`${d.path}\` ${d.change}: ${fmtJson(d.before)} → ${fmtJson(d.after)}${d.claimId ? ` (claim ${d.claimId})` : ''}${d.note ? ` — ${d.note}` : ''}`);
      const repro = r.reproductions[d.id];
      if (repro) {
        L.push('  <details><summary>Reproduction</summary>');
        L.push('');
        L.push('  ```bash');
        for (const line of repro) L.push(`  ${line}`);
        L.push('  ```');
        if (d.evidence) L.push(`  Evidence: ${Object.entries(d.evidence).filter(([, v]) => v).map(([k, v]) => `${k} \`${v}\``).join(', ')}`);
        L.push('  </details>');
      }
    }
    L.push('');
  }

  if (r.preexisting.length) {
    L.push('## PREEXISTING failures');
    L.push('');
    for (const p of r.preexisting) L.push(`- ${p}`);
    L.push('');
  }

  L.push('## Probe coverage');
  L.push('');
  L.push(`${r.coverage.probedRoutes} of ${r.coverage.routes} known routes probed · ${r.coverage.probes.length} probes run (${['hand', 'generated', 'recorded', 'lesson'].map((s) => `${r.coverage.probes.filter((p) => p.source === s).length} ${s}`).join(', ')}).`);
  L.push('');
  if (r.coverage.unprobed.length) {
    L.push('Not probed:');
    for (const u of r.coverage.unprobed) L.push(`- ${u.route} — ${u.reason}`);
    L.push('');
  }

  L.push('## Not verified');
  L.push('');
  L.push('Behaviour that was not probed is unknown, not unchanged.');
  L.push('');
  if (!r.notVerified.length) L.push('- Nothing listed beyond unprobed behaviour.');
  for (const n of r.notVerified) L.push(`- ${n}`);
  L.push('');
  if (r.reviewItems.length) {
    L.push('## Review items (lessons without an executable check)');
    L.push('');
    for (const n of r.reviewItems) L.push(`- ${n}`);
    L.push('');
  }
  if (r.notes.length) {
    L.push('## Notes');
    L.push('');
    for (const n of r.notes) L.push(`- ${n}`);
    L.push('');
  }
  L.push(`Evidence store: \`${r.evidenceDir}\``);
  if (un.length) L.push('', `Correct a false alarm with \`proofloop correct --run ${r.runId} --false-alarm --finding <id> --reason "..."\`.`);
  return L.join('\n') + '\n';
}

/** Short version handed back to an agent by the stop hook. */
export function renderAgentFeedback(r: VerifyReport, reportPath: string): string {
  const L: string[] = [`ProofLoop verification ${r.decision} (run ${r.runId}).`];
  for (const q of r.requirements.filter((x) => x.mandatory && x.status !== 'VERIFIED'))
    L.push(`- ${q.status} ${q.id}: ${q.text} — ${q.outcomes.filter((o) => o.status !== 'VERIFIED').map((o) => o.detail).join('; ')}`);
  for (const d of r.differences.filter((d) => d.class === 'unintended').slice(0, 15)) {
    L.push(`- ${d.id} unintended change in ${d.probeId} at ${d.path}: ${fmtJson(d.before)} → ${fmtJson(d.after)}`);
    const repro = r.reproductions[d.id]?.[0];
    if (repro) L.push(`  reproduce: ${repro}`);
  }
  L.push(`Full report: ${reportPath}`);
  L.push('Fix the code so these differences disappear, or ask the human to approve a change claim. Do not edit tests, the contract or .proofloop files.');
  return L.join('\n');
}
