// cw-ship Workflow: discover -> plan -> resolve (build+merge | park | umbrella).
//
// Launched by SKILL.md with `args` = { repo, defaultBranch, only?, build }.
// Runs headless in the background. Turns captured `feedback:new` / `feedback:go`
// issues into merged changes:
//   - small/medium, no open questions -> branch -> PR (Closes #issue) -> squash-merge
//   - open design questions, OR umbrella-sized but not yet cleared -> PARK:
//     write questions / proposed scope into the issue body, set feedback:needs-input
//   - umbrella-sized AND feedback:go present -> file a ready umbrella + sub-issues;
//     SKILL.md then runs /cw-orchestrate against it to execute autonomously.
//
// Determinism: Workflow scripts forbid Date.now(), Math.random(), and argless
// `new Date()`. This skill mints no timestamps and writes no scratch.
//
// The routing logic below is a verbatim MIRROR of triage.mjs (a Workflow script
// cannot import sibling modules at runtime). tests/mirror.test.mjs fails if they
// drift. The label state machine is references/state-machine.md; the merge
// contract mirrors cw-orchestrate's merge-safety.md.

export const meta = {
  name: 'cw-ship',
  description:
    'Turn captured dogfooding feedback issues into merged changes: plan each against the code, autonomously build+merge the small ones, park the ones needing a design decision (questions synced to the issue body), and file a ready umbrella for the large ones.',
  whenToUse:
    'On a schedule (or on demand) to drain the feedback:new / feedback:go backlog filed by the /cw-feedback skill.',
  phases: [
    { title: 'Discover', detail: 'list open feedback:new / feedback:go issues not already triaging' },
    { title: 'Plan', detail: 'per issue: lock, research vs code, route fix | needs-input | umbrella' },
    { title: 'Resolve', detail: 'build+merge small; park questions to body; file umbrella for large' },
  ],
};

// ---------------------------------------------------------------------------
// Structured-output schemas
// ---------------------------------------------------------------------------

const DISCOVER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['issues'],
  properties: {
    issues: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['issue', 'url', 'has_go'],
        properties: {
          issue: { type: 'integer' },
          url: { type: 'string', minLength: 1 },
          has_go: { type: 'boolean' }, // carries feedback:go (operator cleared it)
          title: { type: 'string' },
        },
      },
    },
  },
};

const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['issue', 'route', 'summary'],
  properties: {
    issue: { type: 'integer' },
    route: { type: 'string', enum: ['fix', 'needs-input', 'umbrella'] },
    summary: { type: 'string', minLength: 1 }, // what the change is, in one paragraph
    open_questions: { type: 'array', items: { type: 'string' } }, // design forks for the operator
    umbrella_scope: {
      type: ['object', 'null'],
      additionalProperties: false,
      required: ['title', 'why', 'sub_issues'],
      properties: {
        title: { type: 'string' },
        why: { type: 'string' },
        sub_issues: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['title', 'what'],
            properties: { title: { type: 'string' }, what: { type: 'string' } },
          },
        },
      },
    },
  },
};

const PARK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['issue', 'parked'],
  properties: {
    issue: { type: 'integer' },
    parked: { type: 'boolean' },
    reason: { type: ['string', 'null'] },
  },
};

const BUILD_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['issue', 'ready_to_merge', 'p0'],
  properties: {
    issue: { type: 'integer' },
    ready_to_merge: { type: 'boolean' },
    p0: { type: 'boolean' },
    pr_number: { type: ['integer', 'null'] },
    pr_url: { type: ['string', 'null'] },
    branch: { type: ['string', 'null'] },
    changed_paths: { type: 'array', items: { type: 'string' } },
    cause: { type: ['string', 'null'] },
  },
};

const MERGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['issue', 'merged'],
  properties: {
    issue: { type: 'integer' },
    merged: { type: 'boolean' },
    pr_state: { type: ['string', 'null'] },
    branch_gone: { type: ['boolean', 'null'] },
    ci_green: { type: ['boolean', 'null'] },
    cause: { type: ['string', 'null'] },
  },
};

const UMBRELLA_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['feedback_issue', 'umbrella'],
  properties: {
    feedback_issue: { type: 'integer' },
    umbrella: { type: ['integer', 'null'] }, // null if filing failed
    umbrella_url: { type: ['string', 'null'] },
    sub_issues: { type: 'array', items: { type: 'integer' } },
    cause: { type: ['string', 'null'] },
  },
};

// ---------------------------------------------------------------------------
// Pure routing logic — MIRROR of triage.mjs (kept in sync; tested there).
// A Workflow script cannot import sibling modules at runtime, so the canonical
// implementation is duplicated here verbatim. Do not edit one without the other.
// ---------------------------------------------------------------------------

function dispositionFor(plan, hasGo) {
  if (!plan || !plan.route) return 'park';
  if (plan.route === 'needs-input') return 'park';
  if (plan.route === 'umbrella') return hasGo ? 'umbrella' : 'park';
  // route === 'fix'
  const qs = ((plan.open_questions || []).length);
  return qs > 0 ? 'park' : 'build';
}

function parkReason(plan, hasGo) {
  if (dispositionFor(plan, hasGo) !== 'park') return null;
  if (plan && plan.route === 'umbrella') return 'umbrella-scope';
  return 'open-questions';
}

function actionQueues(planned) {
  const build = [];
  const umbrella = [];
  const park = [];
  for (const p of (planned || []).filter(Boolean)) {
    const d = dispositionFor(p.plan, p.hasGo);
    if (d === 'build') build.push(p);
    else if (d === 'umbrella') umbrella.push(p);
    else park.push(p);
  }
  return { build, umbrella, park };
}

function escalations(planned) {
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

// ---------------------------------------------------------------------------
// Role prompt builders
// ---------------------------------------------------------------------------

const discoverPrompt = (a) => `You are enumerating open dogfooding-feedback issues in repo ${a.repo} so they can be triaged, using gh via Bash. These were filed by the /cw-feedback skill and follow a label state machine: feedback:new (fresh) and feedback:go (the operator answered earlier open questions and cleared the issue to proceed). feedback:triaging marks an issue another run is already working — SKIP those.

Scope:
${
  Array.isArray(a.only) && a.only.length
    ? `Only these issue numbers: ${a.only.join(', ')}. Verify each is open and carries feedback:new or feedback:go and NOT feedback:triaging; drop any that do not.`
    : `Every OPEN issue labeled feedback:new OR feedback:go, EXCLUDING any also labeled feedback:triaging.`
}

Steps:
1. List both entry states (an issue may match either):
   \`gh issue list --repo ${a.repo} --state open --label feedback:new --json number,title,labels,url --limit 200\`
   \`gh issue list --repo ${a.repo} --state open --label feedback:go --json number,title,labels,url --limit 200\`
2. Union them by number. DROP any issue whose labels include feedback:triaging.
3. For each surviving issue, set has_go = true iff its labels include feedback:go (these carry the operator's inline answers and are cleared to run autonomously). url is the issue's html url.

Return structured output: { issues: [{ issue, url, has_go, title }] }. Return an empty array if nothing is in scope.`;

const planPrompt = (a, issue, url, hasGo) => `You are triaging ONE dogfooding-feedback issue in repo ${a.repo} (default branch ${a.defaultBranch}) and deciding how it should be resolved. Headless, no human in the loop right now. Use gh + git via Bash; read the actual code.

Issue: ${url}
This issue is ${hasGo ? 'CLEARED (feedback:go): the operator has already answered any earlier open questions INLINE IN THE BODY. Read those answers and treat the design as settled — do NOT re-ask questions they already answered.' : 'FRESH (feedback:new): no operator answers yet.'}

STEP 0 — LOCK FIRST (before any analysis):
Add the in-flight lock and clear the entry label so no other run double-processes:
\`gh issue edit ${issue} --repo ${a.repo} --add-label feedback:triaging --remove-label feedback:new --remove-label feedback:go\`
(Create the feedback:triaging label first if missing: \`gh label create feedback:triaging --repo ${a.repo} --color 1D76DB --description "A cw-ship run is working this issue" 2>/dev/null || true\`.)

STEP 1 — UNDERSTAND THE INTENT:
Read the issue body (\`gh issue view ${url} --json title,body\`). It records an Observation, What I don't like, What I want changed, and Context (the product surface). The body captures INTENT, not a prescription — re-derive the real change against the code, don't blindly follow any fix hint.

STEP 2 — RESEARCH AGAINST THE CODE:
Locate the surface in the repo. Confirm what currently happens vs. what the operator wants. Honor repo conventions in AGENTS.md/CLAUDE.md (spec-is-source-of-truth + regen, conventional commits, squash-merge, coverage bar, docs voice, no backwards-compat, etc.).

STEP 3 — ROUTE. Choose exactly one:
- "fix" — the change is a SINGLE squash-mergeable PR and you understand it well enough to implement it correctly with no further operator input. Default to this whenever the work is bounded and the intent is clear (after research). This is the common, desired case: just fix the thing.
- "needs-input" — a genuine DESIGN FORK remains that only the operator should decide (a real trade-off, an exact user-facing string, a scope boundary, a behavior choice). Put each such fork in open_questions as a crisp question, ideally with a recommended answer. Use this ONLY for forks a competent implementer shouldn't decide alone — not for things you can reasonably settle yourself. If this issue is already feedback:go, the operator answered the prior questions; only route needs-input again if a NEW fork surfaced that their answers didn't cover.
- "umbrella" — the change is genuinely multi-PR (several independently mergeable units). Provide umbrella_scope { title, why, sub_issues:[{title, what}] } at one-PR granularity per sub-issue. (If the issue is NOT yet feedback:go, this scope will be parked into the body for the operator to approve; if it IS feedback:go, it will be filed and orchestrated.)

Be conservative: prefer "fix" for bounded work, reserve "needs-input" for real forks, reserve "umbrella" for genuinely large initiatives. Set open_questions=[] and umbrella_scope=null when not applicable.

Return structured output: { issue: ${issue}, route, summary, open_questions, umbrella_scope }.`;

const parkPrompt = (a, p, reason) => `You are PARKING one feedback issue for the operator's input, using gh via Bash. Repo ${a.repo}. Issue: ${p.url} (#${p.issue}).

Reason: ${reason === 'umbrella-scope' ? 'this feedback is umbrella-sized and needs the operator to approve a proposed scope before it is filed and executed.' : 'a design fork remains that only the operator should decide.'}

IMPORTANT — you run CONCURRENTLY with other park subagents in a SHARED working tree. Never write to a fixed, shared filename: a sibling parking a different issue would clobber it and you'd push the wrong issue's body. Key every file you touch by THIS issue number (#${p.issue}) so no two subagents collide.

Steps:
1. Fetch the current title AND body for THIS issue into per-issue, collision-free files:
   \`gh issue view ${p.issue} --repo ${a.repo} --json title -q .title > title-${p.issue}.md\`
   \`gh issue view ${p.issue} --repo ${a.repo} --json body -q .body > body-${p.issue}.md\`
2. Append (do not overwrite) a block to body-${p.issue}.md:
${
  reason === 'umbrella-scope'
    ? `   "## Proposed umbrella scope" followed by the title + why + a checklist of the proposed sub-issues from this scope:
${JSON.stringify(p.plan.umbrella_scope, null, 2)}
   End with: "_To proceed: confirm or edit this scope above, then add the \\\`feedback:go\\\` label. The loop will file the umbrella and hand it to cw-orchestrate._"`
    : `   "## Open questions" followed by a numbered list of these questions, each on its own line:
${JSON.stringify(p.plan.open_questions || [], null, 2)}
   End with: "_To proceed: answer each question inline above, then add the \\\`feedback:go\\\` label._"`
}
3. GUARD before you push — detect a contaminated read instead of compounding it. Re-fetch this issue's current title (\`gh issue view ${p.issue} --repo ${a.repo} --json title -q .title\`) and confirm it equals the contents of title-${p.issue}.md. Then confirm body-${p.issue}.md still leads with THIS issue's body — its leading content must match the body you fetched for #${p.issue} (i.e. it begins with #${p.issue}'s original Observation / body text, with ONLY your appended block added at the end and no other issue's content). If either check fails — the title differs, the body no longer matches #${p.issue}, or a foreign Observation or a duplicate appended block is present — ABORT the write: do NOT run \`gh issue edit\`, return { issue: ${p.issue}, parked: false, reason: "${reason}" } and report the mismatch as the cause. Only when both checks pass, write back: \`gh issue edit ${p.issue} --repo ${a.repo} --body-file body-${p.issue}.md\` (never hand-escape backticks or checklists).
4. Flip labels to the parked state: \`gh issue edit ${p.issue} --repo ${a.repo} --add-label feedback:needs-input --remove-label feedback:triaging\` (create feedback:needs-input first if missing: color D93F0B). Do NOT add feedback:go — that is the operator's action.

Return structured output: { issue: ${p.issue}, parked: true, reason: "${reason}" } once the body is written and labels flipped (or parked: false with the mismatch cause if the guard aborted the write).`;

const buildPrompt = (a, p) => `You are implementing ONE feedback change end-to-end in an isolated git worktree, headless, with no human. Do NOT merge; the orchestrator merges serially after you return.

Repo ${a.repo}, base ${a.defaultBranch}. The change to make (from triage of feedback #${p.issue} — ${p.url}):
${p.plan.summary}

Steps:
1. Branch off fresh \`${a.defaultBranch}\` in your worktree.
2. Implement the change. Stay strictly in scope — implement what the feedback asked for and nothing more. If, mid-implementation, you hit a genuine design fork you cannot settle (a real trade-off or a user-facing string the operator should pick), STOP: do not open a PR. Report ready_to_merge:false with cause "needs-input: <the question>" so the loop parks it back to the operator instead of guessing.
3. Follow repo conventions (AGENTS.md/CLAUDE.md): if the change touches the OpenAPI spec, edit the spec and regenerate (never hand-edit generated files); add or extend tests for the changed behavior (every bug fix gets a regression test that fails before and passes after); keep coverage above the repo bar. Run the build + full test suite; tests must pass before you open a PR.
4. Open a PR. Conventional-commit title (\`fix\`/\`feat\`/\`docs\`/\`refactor\` scope as fits the feedback). Body: Summary + Test plan, and \`Closes #${p.issue}\` on its own line so the merge closes the feedback issue. Push the branch.
5. Run a code-review pass on your own diff. A P0 is a correctness/security/data-loss/scope finding that must not merge. Fix and re-review if you can; if a P0 cannot be safely auto-fixed, leave the PR open and report p0:true.
6. Report issue=${p.issue}, the PR number/URL, branch, files changed, verdict.

If you cannot reach green build + passing tests + clean review, report ready_to_merge:false with the cause rather than papering over it.

Return structured output: { issue, ready_to_merge, p0, pr_number, pr_url, branch, changed_paths, cause }.`;

const mergePrompt = (a, built) => `You are performing a SERIALIZED merge of one already-built PR to \`${a.defaultBranch}\` in repo ${a.repo}, headless, with no human. Only one merge runs at a time; you are it right now.

PR #${built.pr_number} (${built.pr_url}), branch \`${built.branch}\`, feedback #${built.issue}.

Steps:
1. \`git fetch origin ${a.defaultBranch} ${built.branch}\`.
2. PRE-MERGE CONFLICT CHECK against FRESH ${a.defaultBranch}: \`git merge-tree --write-tree --name-only origin/${a.defaultBranch} origin/${built.branch}\`. If it reports a conflict, do NOT merge: try ONE clean rebase of the branch onto fresh ${a.defaultBranch} and push with --force-with-lease; if it still conflicts or needs human judgment, report merged:false, cause "pre-merge conflict against ${a.defaultBranch}".
3. If clean: \`gh pr merge ${built.pr_number} --repo ${a.repo} --squash --admin --delete-branch\`.
4. Verify: PR state is MERGED; branch is gone (\`git ls-remote --heads origin ${built.branch}\` empty — if not, \`git push origin --delete ${built.branch}\`). The merge closes feedback #${built.issue} via the Closes line; confirm it is closed.
5. Post-merge CI: check ${a.defaultBranch} CI for the merge commit is green.

Green = PR MERGED AND post-merge ${a.defaultBranch} CI green. Anything else is not green; report the cause. Never force-resolve a conflict.

Return structured output: { issue, merged, pr_state, branch_gone, ci_green, cause }.`;

const umbrellaPrompt = (a, p) => `You are filing a ready-to-orchestrate GitHub umbrella from an operator-APPROVED scope, using gh via Bash. Repo ${a.repo}. The operator added feedback:go, so the scope below is settled — file it; do not re-ask.

Source feedback issue: ${p.url} (#${p.issue}). Approved scope (the operator may have edited the body; if the issue body's "## Proposed umbrella scope" differs from this, the BODY wins — re-read it first):
${JSON.stringify(p.plan.umbrella_scope, null, 2)}

Steps:
1. Re-read the feedback body for the operator's final scope edits: \`gh issue view ${p.issue} --repo ${a.repo} --json body\`.
2. File the umbrella issue. Body: a human "Why" (from the scope's why + the feedback), then a checklist of sub-issues. Mirror this repo family's umbrella conventions (see any recent umbrella issue for shape). Label it as the repo's umbrellas are labeled if such a label exists.
3. File each sub-issue at one-PR granularity with a body the cw-orchestrate readiness sweep can route "ready": What this is, Constraints (from AGENTS.md/CLAUDE.md), Acceptance (incl. regression tests). Backfill the umbrella checklist with the real sub-issue numbers (\`--body-file\`, never hand-escape).
4. Link back: add "Spawned from feedback #${p.issue}" to the umbrella body, and CLOSE the feedback issue with a comment "Tracked by umbrella #<n>; execution handed to cw-orchestrate." Remove its feedback:triaging label.

Return structured output: { feedback_issue: ${p.issue}, umbrella, umbrella_url, sub_issues, cause }. Set umbrella=null with a cause if you could not file it.`;

// ---------------------------------------------------------------------------
// Orchestration body
// ---------------------------------------------------------------------------

let cfg = args;
if (typeof cfg === 'string') {
  try {
    cfg = JSON.parse(cfg);
  } catch (e) {
    throw new Error(`cw-ship: args is a string but not valid JSON: ${e.message}`);
  }
}
if (!cfg || !cfg.repo) {
  throw new Error('cw-ship: args must include { repo }');
}
cfg.defaultBranch = cfg.defaultBranch || 'main';
const runBuild = cfg.build !== false; // default on

// --- Discover --------------------------------------------------------------
phase('Discover');
const discovered = await agent(discoverPrompt(cfg), {
  label: 'discover',
  phase: 'Discover',
  schema: DISCOVER_SCHEMA,
});
const issues = (discovered && discovered.issues) || [];
log(`Discovered ${issues.length} open feedback issue(s) in scope.`);
if (issues.length === 0) {
  return { repo: cfg.repo, planned: [], built: [], umbrellas_filed: [], escalations: [] };
}

// --- Plan (lock + classify), one subagent per issue, in parallel -----------
phase('Plan');
const planResults = await parallel(
  issues.map((it) => () =>
    agent(planPrompt(cfg, it.issue, it.url, it.has_go), {
      label: `plan:${it.issue}`,
      phase: 'Plan',
      schema: PLAN_SCHEMA,
    }),
  ),
);
const planned = issues
  .map((it, i) => (planResults[i] ? { issue: it.issue, url: it.url, hasGo: it.has_go, plan: planResults[i] } : null))
  .filter(Boolean);

const queues = actionQueues(planned);
log(`Planned: build=${queues.build.length} umbrella=${queues.umbrella.length} park=${queues.park.length}.`);

// --- Resolve ---------------------------------------------------------------
phase('Resolve');

// Park (parallel): write questions / proposed scope into the body, set needs-input.
await parallel(
  queues.park.map((p) => () =>
    agent(parkPrompt(cfg, p, parkReason(p.plan, p.hasGo)), {
      label: `park:${p.issue}`,
      phase: 'Resolve',
      schema: PARK_SCHEMA,
    }),
  ),
);

// Umbrella (serial): file a ready umbrella per approved scope.
const umbrellas_filed = [];
for (const p of queues.umbrella) {
  const u = await agent(umbrellaPrompt(cfg, p), {
    label: `umbrella:${p.issue}`,
    phase: 'Resolve',
    schema: UMBRELLA_SCHEMA,
  });
  if (u && u.umbrella) {
    umbrellas_filed.push({ feedback_issue: p.issue, umbrella: u.umbrella, url: u.umbrella_url || null, sub_issues: u.sub_issues || [] });
    log(`Filed umbrella #${u.umbrella} from feedback #${p.issue}.`);
  } else {
    log(`Umbrella filing failed for feedback #${p.issue}: ${u?.cause || 'unknown'}`);
  }
}

// Build (serial over a quiescent default branch): implement -> PR -> merge.
const built = [];
if (runBuild) {
  for (const p of queues.build) {
    const b = await agent(buildPrompt(cfg, p), {
      label: `build:${p.issue}`,
      phase: 'Resolve',
      isolation: 'worktree',
      schema: BUILD_SCHEMA,
    });
    if (!b || !b.ready_to_merge || b.p0) {
      // A planner-missed design fork surfaces here as cause "needs-input: ...".
      built.push({ issue: p.issue, pr: b?.pr_url || null, merged: false, cause: b?.p0 ? 'P0 on diff; PR left open' : b?.cause || 'build not mergeable' });
      log(`Build #${p.issue}: not merged — ${b?.cause || 'not mergeable'}`);
      continue;
    }
    const m = await agent(mergePrompt(cfg, b), {
      label: `merge:${p.issue}`,
      phase: 'Resolve',
      schema: MERGE_SCHEMA,
    });
    const merged = !!(m.merged && m.ci_green !== false);
    built.push({ issue: p.issue, pr: b.pr_url || null, merged, cause: merged ? null : m.cause || 'merge not green' });
    log(`Build #${p.issue}: ${merged ? 'merged' : 'stalled — ' + (m.cause || 'not green')}`);
  }
}

// --- Report ----------------------------------------------------------------
const report = {
  repo: cfg.repo,
  planned: planned.map((p) => ({ issue: p.issue, route: p.plan.route, disposition: dispositionFor(p.plan, p.hasGo) })),
  built,
  umbrellas_filed,
  escalations: escalations(planned),
};
log(
  `Done. planned=${report.planned.length} merged=${report.built.filter((b) => b.merged).length}/${report.built.length} ` +
    `umbrellas=${report.umbrellas_filed.length} parked=${report.escalations.length}`,
);
return report;
