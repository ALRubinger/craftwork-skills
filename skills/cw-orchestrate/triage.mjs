// Canonical, pure, unit-tested triage decision logic for cw-review-residual issues.
//
// `workflow.js` inlines a byte-for-byte mirror of these functions because a
// Claude Code Workflow script (a) auto-runs its body on evaluation and (b) has
// no filesystem/module access at runtime, so it can neither be imported by a
// Node test nor import this module. This file is the tested source of truth;
// keep the mirror in workflow.js in sync (mirror.test.mjs enforces it).
//
// The standalone `cw-sweep` skill carries its own self-contained copy of
// this file; this one is the upstream origin. Pure: no Date.now(),
// Math.random(), or argless `new Date()` (all forbidden in Workflow scripts).
//
// A triage RESULT for one cw-review-residual issue has the shape:
//   {
//     residual_issue: number,   // the cw-review-residual issue (e.g. 1000)
//     sub_issue:      number,   // the feature sub-issue it tracks (e.g. 986)
//     shipped:        boolean,  // is the sub-issue's code merged? false => can't triage yet
//     closed:         boolean,  // did the triage subagent close the residual
//     findings: [{
//       title:      string,
//       severity:   'P0' | 'P1' | 'P2',
//       verdict:    'RESOLVED' | 'FIX_NOW' | 'DECISION' | 'MOOT',
//       confidence: 'high' | 'low',   // load-bearing ONLY when verdict === 'FIX_NOW'
//       rationale:  string,
//       fix_hint:   string | null,
//     }]
//   }
//
// Verdict meanings (against the SHIPPED code, not the plan):
//   RESOLVED — the merged code already does the right thing; nothing to do.
//   FIX_NOW  — a real, cheap, correct fix. confidence 'high' => auto-fixable;
//              confidence 'low' => escalate (the classifier isn't sure it's safe).
//   DECISION — needs a human judgment call; never auto-fixed.
//   MOOT     — the finding was wrong or overtaken by the implementation.

/**
 * What should happen to a residual after triage, derived purely from its findings.
 *   'close-now'        — nothing requires action (all RESOLVED/MOOT); close immediately.
 *   'close-via-autofix' — only RESOLVED/MOOT + high-confidence FIX_NOW remain; the
 *                         autofix PR addresses the fixes and closes the residual.
 *   'keep-open'        — at least one DECISION or low-confidence FIX_NOW remains; a
 *                         human (or the standalone skill) must finish it.
 *
 * @param {{findings?: Array}} result
 * @returns {'close-now'|'close-via-autofix'|'keep-open'}
 */
export function closeDisposition(result) {
  const findings = (result && result.findings) || [];
  if (findings.length === 0) return 'close-now';
  const noHumanNeeded = findings.every(
    (f) =>
      f.verdict === 'RESOLVED' ||
      f.verdict === 'MOOT' ||
      (f.verdict === 'FIX_NOW' && f.confidence === 'high'),
  );
  if (!noHumanNeeded) return 'keep-open';
  const anyFix = findings.some((f) => f.verdict === 'FIX_NOW' && f.confidence === 'high');
  return anyFix ? 'close-via-autofix' : 'close-now';
}

/**
 * The findings safe to auto-fix in one residual: FIX_NOW marked high-confidence.
 * @param {{findings?: Array}} result
 * @returns {Array}
 */
export function highConfidenceFixes(result) {
  return ((result && result.findings) || []).filter(
    (f) => f.verdict === 'FIX_NOW' && f.confidence === 'high',
  );
}

/**
 * Residual-issue numbers that warrant an autofix PR (>=1 high-confidence FIX_NOW),
 * ascending. This is the gate that decides what lands code unsupervised, so it is
 * intentionally strict: a low-confidence FIX_NOW does NOT qualify.
 * @param {Array} results
 * @returns {number[]}
 */
export function autofixCandidates(results) {
  return (results || [])
    .filter(Boolean)
    .filter((r) => highConfidenceFixes(r).length > 0)
    .map((r) => r.residual_issue)
    .sort((a, b) => a - b);
}

/**
 * Findings that need a human: every DECISION, plus any FIX_NOW the classifier
 * marked low-confidence (not safe to auto-apply). Flattened, residual-ascending.
 * @param {Array} results
 * @returns {Array}
 */
export function escalations(results) {
  const out = [];
  for (const r of (results || []).filter(Boolean)) {
    for (const f of r.findings || []) {
      const needsHuman =
        f.verdict === 'DECISION' || (f.verdict === 'FIX_NOW' && f.confidence !== 'high');
      if (needsHuman) {
        out.push({
          residual_issue: r.residual_issue,
          sub_issue: r.sub_issue,
          title: f.title,
          severity: f.severity || null,
          verdict: f.verdict,
          confidence: f.confidence || null,
          rationale: f.rationale || '',
        });
      }
    }
  }
  return out.sort((a, b) => a.residual_issue - b.residual_issue);
}

/**
 * Residuals that could not be triaged because the sub-issue's code has not shipped
 * (halted/stalled). These defer to a later run, ascending.
 * @param {Array} results
 * @returns {number[]}
 */
export function deferredResiduals(results) {
  return (results || [])
    .filter(Boolean)
    .filter((r) => r.shipped === false)
    .map((r) => r.residual_issue)
    .sort((a, b) => a - b);
}
