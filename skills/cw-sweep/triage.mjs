// Canonical, pure, unit-tested triage decision logic for cw-review-residual issues.
//
// Self-contained copy for the cw-sweep skill. The upstream origin is
// cw-orchestrate/triage.mjs; the shared classifiers (closeDisposition,
// highConfidenceFixes, autofixCandidates, deferredResiduals) are kept identical
// so both skills classify residuals the same way. cw-sweep additionally drives a
// human-decision park/resolve/go loop the in-run cw-orchestrate path does not, so
// this copy EXTENDS the shared logic: escalations() carries the recommendation
// fields and skips unshipped residuals, and parkCandidates() is cw-sweep-only.
// (The escalations shipped-guard is a no-op in-run, where residuals are always
// freshly shipped.) `workflow.js` inlines a byte-for-byte mirror of every
// function here (a Workflow script cannot import at runtime); mirror.test.mjs
// guards that drift. Pure: no Date.now(), Math.random(), or argless `new Date()`.
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
//       // Present ONLY on findings that need a human (DECISION or low-conf FIX_NOW),
//       // so the operator can be asked with a recommendation-first AskUserQuestion
//       // and the same data can be written into the parked "## Decision needed" block:
//       decision_question:  string | null,   // one-line question to show the operator
//       recommended_answer: string | null,   // the planner's pick (first option, "Recommended")
//       alt_options:        string[],         // 1-3 realistic alternative answers
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
 * ascending. The strict gate on what lands code unsupervised.
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
 * Genuine human decisions on SHIPPED residuals: every DECISION, plus any
 * low-confidence FIX_NOW. Carries the question fields so the caller can render a
 * recommendation-first AskUserQuestion (interactive) or a parked
 * "## Decision needed" block (headless) from one source of truth. Unshipped
 * (shipped === false) residuals are excluded — their findings are deferral
 * placeholders, not real decisions; deferredResiduals() surfaces those instead.
 * @param {Array} results
 * @returns {Array}
 */
export function escalations(results) {
  const out = [];
  for (const r of (results || []).filter(Boolean)) {
    if (r.shipped === false) continue;
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
          decision_question: f.decision_question || f.title,
          recommended_answer: f.recommended_answer || null,
          alt_options: f.alt_options || [],
        });
      }
    }
  }
  return out.sort((a, b) => a.residual_issue - b.residual_issue);
}

/**
 * Residual-issue numbers to PARK for operator input on a headless run: SHIPPED
 * residuals carrying at least one human-needed finding (DECISION or low-conf
 * FIX_NOW), ascending. The headless analog of autofixCandidates() — the set that
 * gets a "## Decision needed" block + the cw-review-residual:needs-input label.
 * Unshipped residuals defer (deferredResiduals) rather than park.
 * @param {Array} results
 * @returns {number[]}
 */
export function parkCandidates(results) {
  return (results || [])
    .filter(Boolean)
    .filter(
      (r) =>
        r.shipped !== false &&
        (r.findings || []).some(
          (f) => f.verdict === 'DECISION' || (f.verdict === 'FIX_NOW' && f.confidence !== 'high'),
        ),
    )
    .map((r) => r.residual_issue)
    .sort((a, b) => a - b);
}

/**
 * Residuals that could not be triaged because the sub-issue has not shipped.
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
