// Pure routing logic for cw-ship. This is the CANONICAL implementation;
// workflow.js inlines a verbatim mirror of these functions (a Workflow script
// cannot import sibling modules at runtime). tests/triage.test.mjs exercises
// these; tests/mirror.test.mjs fails if the two copies drift.
//
// A "planned" item is { issue, url, hasGo, plan }, where plan is the structured
// output of the per-issue planner:
//   plan.route          ∈ 'fix' | 'needs-input' | 'umbrella'
//   plan.open_questions   array of question strings (may be empty)
//   plan.umbrella_scope   proposed scope object | null (only when route umbrella)
// hasGo is true when the issue carries the feedback:go label (operator cleared it).

// Decide what the loop does with one planned issue:
//   'build'    — small/medium, no open questions → branch, PR, merge autonomously
//   'umbrella' — umbrella-sized AND cleared (hasGo) → file umbrella + orchestrate
//   'park'     — open questions remain, OR umbrella-sized but not yet cleared
export function dispositionFor(plan, hasGo) {
  if (!plan || !plan.route) return 'park';
  if (plan.route === 'yielded') return 'skip'; // lost the claim race — another run owns this issue
  if (plan.route === 'needs-input') return 'park';
  if (plan.route === 'umbrella') return hasGo ? 'umbrella' : 'park';
  // route === 'fix'
  const qs = ((plan.open_questions || []).length);
  return qs > 0 ? 'park' : 'build';
}

// Why a parked issue is parked — drives which body block the loop writes.
//   'umbrella-scope' — propose an umbrella scope for the operator to approve
//   'open-questions' — design questions the planner needs answered
//   null             — not parked
export function parkReason(plan, hasGo) {
  if (dispositionFor(plan, hasGo) !== 'park') return null;
  if (plan && plan.route === 'umbrella') return 'umbrella-scope';
  return 'open-questions';
}

// Partition planned issues into action queues, preserving discovery order.
export function actionQueues(planned) {
  const build = [];
  const umbrella = [];
  const park = [];
  for (const p of (planned || []).filter(Boolean)) {
    const d = dispositionFor(p.plan, p.hasGo);
    if (d === 'build') build.push(p);
    else if (d === 'umbrella') umbrella.push(p);
    else if (d === 'park') park.push(p);
    // d === 'skip' (yielded): another run owns the issue — do nothing with it.
  }
  return { build, umbrella, park };
}

// Issues that need the operator this run (everything parked), sorted by number.
export function escalations(planned) {
  return (planned || [])
    .filter(Boolean)
    .filter((p) => dispositionFor(p.plan, p.hasGo) === 'park')
    .map((p) => ({
      issue: p.issue,
      url: p.url,
      reason: parkReason(p.plan, p.hasGo),
      questions: (p.plan && p.plan.open_questions) || [],
    }))
    .sort((a, b) => a.issue - b.issue);
}
