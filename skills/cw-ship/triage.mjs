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
//
// hasGo (the cw-feedback:go label) no longer affects DISPOSITION. Its only role is
// upstream, in the planner: a go issue carries the operator's inline answers to an
// earlier fork, so the planner treats that fork as settled and routes 'fix' or
// 'umbrella' instead of re-parking. By the time a plan reaches these functions the
// route already encodes everything — 'umbrella' means "file it and orchestrate",
// 'needs-input' (or 'fix' with leftover open_questions) means "a genuine design
// fork remains → park". So routing is a pure function of the plan alone.

// Decide what the loop does with one planned issue:
//   'build'    — small/medium, no open questions → branch, PR, merge autonomously
//   'umbrella' — umbrella-sized, intent clear → file umbrella + orchestrate (no go gate)
//   'park'     — a genuine design fork remains (needs-input, or fix w/ open questions)
export function dispositionFor(plan) {
  if (!plan || !plan.route) return 'park';
  if (plan.route === 'yielded') return 'skip'; // lost the claim race — another run owns this issue
  if (plan.route === 'needs-input') return 'park';
  if (plan.route === 'umbrella') return 'umbrella'; // umbrella-sized + intent clear auto-files; go is not required
  // route === 'fix'
  const qs = ((plan.open_questions || []).length);
  return qs > 0 ? 'park' : 'build';
}

// Why a parked issue is parked. Since umbrella-ness alone no longer parks (an
// umbrella-sized issue with clear intent files directly), the only remaining
// parking reason is a genuine design fork the operator must settle.
//   'open-questions' — design fork(s) the planner needs the operator to answer
//   null             — not parked
export function parkReason(plan) {
  return dispositionFor(plan) === 'park' ? 'open-questions' : null;
}

// Partition planned issues into action queues, preserving discovery order.
export function actionQueues(planned) {
  const build = [];
  const umbrella = [];
  const park = [];
  for (const p of (planned || []).filter(Boolean)) {
    const d = dispositionFor(p.plan);
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
    .filter((p) => dispositionFor(p.plan) === 'park')
    .map((p) => ({
      issue: p.issue,
      url: p.url,
      reason: parkReason(p.plan),
      questions: (p.plan && p.plan.open_questions) || [],
    }))
    .sort((a, b) => a.issue - b.issue);
}
