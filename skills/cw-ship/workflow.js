// cw-ship Workflow: discover -> plan -> resolve (build+merge | park | umbrella).
//
// Launched by SKILL.md with `args` = { repo, defaultBranch, only?, build }.
// Runs headless in the background. Turns captured `cw-feedback:new` / `cw-feedback:go`
// issues into merged changes:
//   - small/medium, no open questions -> branch -> PR (Closes #issue) -> squash-merge
//   - open design questions, OR umbrella-sized but not yet cleared -> PARK:
//     write questions / proposed scope into the issue body, set cw-feedback:needs-input
//   - umbrella-sized AND cw-feedback:go present -> file a ready umbrella + sub-issues;
//     SKILL.md then runs /cw-orchestrate against it to execute autonomously.
//
// Determinism: Workflow scripts forbid Date.now(), Math.random(), and argless
// `new Date()`. This skill mints no timestamps and writes no scratch.
//
// The routing logic below is a verbatim MIRROR of triage.mjs, and the merge-CI
// classification a verbatim MIRROR of merge.mjs (a Workflow script cannot import
// sibling modules at runtime). tests/mirror.test.mjs fails if either drifts. The
// label state machine is references/state-machine.md. The merge contract — a
// pre-merge wait-for-green CI gate (blocking vs. advisory checks), then merge,
// with post-merge CI as an advisory regression detector — mirrors
// cw-orchestrate's merge-safety.md and is shared via merge.mjs / merge-ci.mjs.

export const meta = {
  name: 'cw-ship',
  description:
    'Turn captured dogfooding feedback issues into merged changes: plan each against the code, autonomously build+merge the small ones, park the ones needing a design decision (questions synced to the issue body), and file a ready umbrella for the large ones.',
  whenToUse:
    'On a schedule (or on demand) to drain the cw-feedback:new / cw-feedback:go backlog filed by the /cw-feedback skill.',
  phases: [
    { title: 'Discover', detail: 'list open cw-feedback:new / cw-feedback:go issues not already triaging' },
    { title: 'Plan', detail: 'per issue: claim (race-safe), research vs code, route fix | needs-input | umbrella | yielded' },
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
          has_go: { type: 'boolean' }, // carries cw-feedback:go (operator cleared it)
          reclaim: { type: 'boolean' }, // surfaced from cw-feedback:triaging with a crashed/stale claim
          title: { type: 'string' },
        },
      },
    },
    // Issues in scope but held by ANOTHER run's still-live claim — a first-class,
    // legible outcome distinct from "nothing in scope" and from a real escalation.
    // This is what was missing when an --only run on a live-claimed issue returned a
    // bare planned:[] that looked identical to an empty backlog and tricked a manual
    // claim reset. reclaim_at is when the claim ages out and the loop self-heals.
    claimed_elsewhere: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['issue', 'url', 'last_activity', 'claim_age', 'reclaim_at'],
        properties: {
          issue: { type: 'integer' },
          url: { type: 'string', minLength: 1 },
          last_activity: { type: 'string' }, // issue updatedAt (ISO-8601)
          claim_age: { type: 'string' }, // human age of the owning claim, e.g. "12m"
          reclaim_at: { type: 'string' }, // ISO-8601 instant the claim auto-reclaims
        },
      },
    },
    // Issues carrying cw-feedback:hold — cataloged in the backlog but out of scope
    // for the loop until an operator hand-swaps :hold -> :new. Held issues are
    // invisible to the unscoped query by construction; this field exists so an
    // --only run targeting a held issue surfaces a legible "on hold, skipped"
    // outcome instead of a silent empty result.
    held: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['issue', 'url'],
        properties: {
          issue: { type: 'integer' },
          url: { type: 'string', minLength: 1 },
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
    route: { type: 'string', enum: ['fix', 'needs-input', 'umbrella', 'yielded'] },
    // The id of THIS run's claim comment on the issue, so a later release
    // (park / umbrella / merge) can delete it. Null on a yielded plan (the
    // subagent already deleted its own losing claim).
    claim_comment_id: { type: ['integer', 'null'] },
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
    ci: {
      type: ['object', 'null'],
      additionalProperties: false,
      properties: {
        failing_checks: { type: 'array', items: { type: 'string' } },
        advisory_nonblocking: { type: 'array', items: { type: 'string' } },
        cancelled: { type: 'boolean' },
        pending: { type: 'boolean' },
      },
    },
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
  if (plan.route === 'yielded') return 'skip'; // lost the claim race — another run owns this issue
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
    else if (d === 'park') park.push(p);
    // d === 'skip' (yielded): another run owns the issue — do nothing with it.
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
// Pure merge-CI classification — MIRROR of merge.mjs (kept in sync; tested
// there). A Workflow script cannot import sibling modules at runtime, so the
// canonical implementation is duplicated here verbatim. A cancelled run (GitHub
// Actions concurrency cancel-in-progress, fired when a later commit lands on the
// default branch) is NOT a failure; the PR has already merged either way. Do not
// edit one copy without the other.
// ---------------------------------------------------------------------------

function classifyPostMergeCI(ci) {
  const c = ci || {};
  const failing = (c.failing_checks || []).filter(Boolean);
  if (failing.length > 0) return 'failed';
  if (c.pending) return 'pending';
  if (c.cancelled) return 'superseded';
  return 'green';
}

function postMergeCIStalls(ci) {
  return classifyPostMergeCI(ci) === 'failed';
}

// MIRROR of merge.mjs mergeVerdict (tested there). A merged PR is never reported
// as not-merged; a post-merge regression rides along as a warning. Replaces the
// old inline `!!(m.merged && m.ci_green !== false)`.
function mergeVerdict(m) {
  const r = m || {};
  if (r.merged) {
    return {
      state: 'merged',
      postMergeWarning: postMergeCIStalls(r.ci) ? r.cause || 'post-merge CI regression' : null,
      cause: null,
    };
  }
  return {
    state: 'stalled',
    postMergeWarning: null,
    cause: r.cause || 'merge did not land (pre-merge conflict or failing CI gate)',
  };
}

// ---------------------------------------------------------------------------
// Role prompt builders
// ---------------------------------------------------------------------------

const discoverPrompt = (a) => `You are enumerating open dogfooding-feedback issues in repo ${a.repo} so they can be triaged, using gh via Bash. These were filed by the /cw-feedback skill and follow a label state machine: cw-feedback:new (fresh), cw-feedback:go (the operator answered earlier open questions and cleared the issue to proceed), and cw-feedback:triaging (a run is actively working it). MULTIPLE cw-ship runs can run on this repo at once — there is NO repo lock; the per-issue claim is what serializes work, so a live cw-feedback:triaging issue belongs to another run and you must NOT build it. You DO surface it, but as a distinct \`claimed_elsewhere\` entry (not in \`issues\`), so a run scoped to a live-claimed target reports a legible "held by another run, auto-reclaims at <time>" outcome instead of a bare empty result. The one exception that goes into \`issues\` is a CRASHED claim, which is reclaimable (below).

There is also a HOLD state, cw-feedback:hold: an issue cataloged in the backlog but intentionally OUT OF SCOPE until an operator hand-swaps :hold -> :new. It is mutually exclusive with every other state label, so an unscoped run never sees it — the entry-state queries below list only :new and :go and never list :hold. You must NOT build a held issue. The ONLY time it matters is an --only run scoped directly at a held issue: surface it in \`held\` (not \`issues\`) so the run reports a legible "on hold, skipped" outcome instead of a bare empty result that looks like "nothing in scope".

Scope:
${
  Array.isArray(a.only) && a.only.length
    ? `Only these issue numbers: ${a.only.join(', ')}. Include each that is open and carries cw-feedback:new or cw-feedback:go, OR is cw-feedback:triaging with a CRASHED claim (reclaim rule below); drop the rest. An --only target that instead carries cw-feedback:hold is OUT OF SCOPE — do NOT build it; surface it in \`held\` (step 2b below).`
    : `Every OPEN issue labeled cw-feedback:new OR cw-feedback:go, PLUS any cw-feedback:triaging issue whose claim has crashed (reclaim rule below). Held issues (cw-feedback:hold) are out of scope and never appear here.`
}

Steps:
1. List the entry states (an issue may match either):
   \`gh issue list --repo ${a.repo} --state open --label cw-feedback:new --json number,title,labels,url,updatedAt --limit 200\`
   \`gh issue list --repo ${a.repo} --state open --label cw-feedback:go --json number,title,labels,url,updatedAt --limit 200\`
   Union them by number; for each set has_go = true iff its labels include cw-feedback:go (these carry the operator's inline answers and are cleared to run autonomously), reclaim = false.
${
  Array.isArray(a.only) && a.only.length
    ? `1b. HOLD CHECK (only matters for --only). For each --only target NOT already matched above, read its labels (\`gh issue view <n> --repo ${a.repo} --json number,title,labels,url,state\`). If it is OPEN and carries cw-feedback:hold, add it to \`held\` as { issue, url, title } and do NOT include it in \`issues\` — it is cataloged but out of scope until an operator swaps :hold -> :new. (Unscoped runs skip this step entirely: held issues never match the entry-state queries.)\n`
    : ''
}2. RECLAIM PASS — recover issues stranded by a crashed run, and surface live-claimed ones as a first-class outcome. List \`gh issue list --repo ${a.repo} --state open --label cw-feedback:triaging --json number,title,labels,url,updatedAt --limit 200\`${
  Array.isArray(a.only) && a.only.length
    ? `, then KEEP ONLY the issues in the --only set (${a.only.join(', ')}) — both crashed reclaims and claimed_elsewhere stay scoped to --only`
    : ''
}. For EACH, decide if its claim has crashed:
   a. Read its claim comments: \`gh api repos/${a.repo}/issues/<n>/comments --paginate --jq '.[] | select(.body | contains("<!-- cw-ship/claim -->")) | {id, created_at}'\`.
   b. Check for live work: is there an OPEN PR referencing #<n>? (\`gh pr list --repo ${a.repo} --state open --search "<n> in:body" --json number\`, plus a \`Closes #<n>\` scan).
   c. A claim is CRASHED iff: there is NO open PR for the issue, AND the newest claim comment's created_at is more than 2 HOURS before now, AND the issue's updatedAt is more than 2 hours before now. (Use \`date -u +%s\` for now; compare epoch seconds. A triaging issue with NO claim comment at all — e.g. an old pre-redesign run — also counts as crashed.)
   d. If crashed → include it in \`issues\` with has_go = (labels include cw-feedback:go), reclaim = true.
   e. If NOT crashed (a live claim — an open PR, recently updated, or a claim younger than 2h) → another run owns it RIGHT NOW. Do NOT build it and do NOT silently drop it: add it to \`claimed_elsewhere\` with last_activity = the issue's updatedAt, claim_age = the human age of the newest claim comment relative to now (e.g. "12m", "1h05m"), and reclaim_at = the newest claim comment's created_at PLUS 2 hours, in ISO-8601 (the instant the loop auto-reclaims it if the run stays dead — the operator should WAIT for that rather than manually resetting the label and racing a possibly-live run). This is the distinct, legible signal that was missing when a live-claimed --only target returned a bare empty result that looked identical to "nothing in scope".
3. url is each issue's html url.

Return structured output: { issues: [{ issue, url, has_go, reclaim, title }], claimed_elsewhere: [{ issue, url, last_activity, claim_age, reclaim_at }], held: [{ issue, url, title }] }. Return empty arrays when the respective set is empty. NEVER put a live-claimed cw-feedback:triaging issue in \`issues\` — it goes in \`claimed_elsewhere\`; only a provably-crashed claim goes in \`issues\` with reclaim = true. NEVER put a cw-feedback:hold issue in \`issues\` — it goes in \`held\` (and only ever when explicitly --only-targeted).`;

const planPrompt = (a, issue, url, hasGo, reclaim) => `You are triaging ONE dogfooding-feedback issue in repo ${a.repo} (default branch ${a.defaultBranch}) and deciding how it should be resolved. Headless, no human in the loop right now. Use gh + git via Bash; read the actual code.

Issue: ${url}
This issue is ${hasGo ? 'CLEARED (cw-feedback:go): the operator has already answered any earlier open questions INLINE IN THE BODY. Read those answers and treat the design as settled — do NOT re-ask questions they already answered.' : 'FRESH (cw-feedback:new): no operator answers yet.'}${reclaim ? '\nIt was RECLAIMED from a crashed run (it was cw-feedback:triaging with a stale/crashed claim). Read the body to see whether the operator already answered earlier questions before deciding.' : ''}

STEP 0 — CLAIM THIS ISSUE (race-safe; before ANY analysis). Several cw-ship runs may process this repo at once; there is NO repo lock. The per-issue claim is the ONLY thing that prevents two runs building the same issue, so acquire it and CONFIRM YOU OWN IT before doing anything else. Never rely on a process being alive — claims are GitHub comments with server-assigned id + created_at.
  a. POST your claim and capture its id:
     \`MY_ID=$(gh api repos/${a.repo}/issues/${issue}/comments -f body='<!-- cw-ship/claim -->' --jq .id)\`
     (The comment's server-side created_at + id ARE your claim's identity — do not self-stamp a timestamp.)
  b. Mark the issue in-flight and clear the entry AND terminal labels (idempotent — harmless if a racing run already did it; create labels if missing). cw-feedback:triaging and the terminal labels are MUTUALLY EXCLUSIVE: an actively-worked issue is not parked, so claiming it removes cw-feedback:needs-input too (a reclaim of a stranded park, or a cw-feedback:go re-entry, must not leave the issue carrying both the claim label and a terminal label — that both-labels state is the invariant violation this fixes):
     \`gh issue edit ${issue} --repo ${a.repo} --add-label cw-feedback:triaging --remove-label cw-feedback:new --remove-label cw-feedback:go --remove-label cw-feedback:needs-input\`
     (create: \`gh label create cw-feedback:triaging --repo ${a.repo} --color 1D76DB --description "A cw-ship run is working this issue" 2>/dev/null || true\`)
  c. VERIFY OWNERSHIP — re-read EVERY claim comment, then apply the rule:
     \`gh api repos/${a.repo}/issues/${issue}/comments --paginate --jq '.[] | select(.body | contains("<!-- cw-ship/claim -->")) | {id, created_at}'\`
     Also determine, for staleness: is there an OPEN PR referencing #${issue}? and the issue's updatedAt. A claim is STALE iff it is >2h old AND there is no open PR for the issue AND the issue's updatedAt is >2h ago. The OWNER is the claim with the EARLIEST created_at among NON-stale claims; ties broken by the LOWEST numeric comment id.
  d. If \$MY_ID is the owner → you hold the issue; continue to STEP 1.
     If \$MY_ID is NOT the owner → another run claimed first. YIELD: delete your own claim comment (\`gh api -X DELETE repos/${a.repo}/issues/comments/\$MY_ID\`), do NOT remove cw-feedback:triaging (the owner needs it), and return { issue: ${issue}, route: "yielded", claim_comment_id: null, summary: "yielded: <owner claim id> owns this issue" } WITHOUT analyzing or building anything. This is the whole point — never build an issue you do not own.
  (A reclaimed issue's prior claim is stale, so your fresh claim is the only non-stale one and you become the owner.)

STEP 1 — UNDERSTAND THE INTENT:
Read the issue body (\`gh issue view ${url} --json title,body\`). It records an Observation, What I don't like, What I want changed, and Context (the product surface). The body captures INTENT, not a prescription — re-derive the real change against the code, don't blindly follow any fix hint.

STEP 2 — RESEARCH AGAINST THE CODE:
Locate the surface in the repo. Confirm what currently happens vs. what the operator wants. Honor repo conventions in AGENTS.md/CLAUDE.md (spec-is-source-of-truth + regen, conventional commits, squash-merge, coverage bar, docs voice, no backwards-compat, etc.).

STEP 3 — ROUTE. Choose exactly one:
- "fix" — the change is a SINGLE squash-mergeable PR and you understand it well enough to implement it correctly with no further operator input. Default to this whenever the work is bounded and the intent is clear (after research). This is the common, desired case: just fix the thing.
- "needs-input" — a genuine DESIGN FORK remains that only the operator should decide (a real trade-off, an exact user-facing string, a scope boundary, a behavior choice). Put each such fork in open_questions as a crisp question, ideally with a recommended answer. Use this ONLY for forks a competent implementer shouldn't decide alone — not for things you can reasonably settle yourself. If this issue is already cw-feedback:go, the operator answered the prior questions; only route needs-input again if a NEW fork surfaced that their answers didn't cover.
- "umbrella" — the change is genuinely multi-PR (several independently mergeable units). Provide umbrella_scope { title, why, sub_issues:[{title, what}] } at one-PR granularity per sub-issue. (If the issue is NOT yet cw-feedback:go, this scope will be parked into the body for the operator to approve; if it IS cw-feedback:go, it will be filed and orchestrated.)

Be conservative: prefer "fix" for bounded work, reserve "needs-input" for real forks, reserve "umbrella" for genuinely large initiatives. Set open_questions=[] and umbrella_scope=null when not applicable.

Return structured output: { issue: ${issue}, route, claim_comment_id, summary, open_questions, umbrella_scope }. When you OWN the issue, set claim_comment_id = \$MY_ID (the id from STEP 0a) so a later release can delete your claim. When you yielded, route="yielded" and claim_comment_id=null.`;

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
   End with: "_To proceed: confirm or edit this scope above, then add the \\\`cw-feedback:go\\\` label. The loop will file the umbrella and hand it to cw-orchestrate._"`
    : `   "## Open questions" followed by a numbered list of these questions, each on its own line:
${JSON.stringify(p.plan.open_questions || [], null, 2)}
   End with: "_To proceed: answer each question inline above, then add the \\\`cw-feedback:go\\\` label._"`
}
3. GUARD before you push — detect a contaminated read instead of compounding it. Re-fetch this issue's current title (\`gh issue view ${p.issue} --repo ${a.repo} --json title -q .title\`) and confirm it equals the contents of title-${p.issue}.md. Then confirm body-${p.issue}.md still leads with THIS issue's body — its leading content must match the body you fetched for #${p.issue} (i.e. it begins with #${p.issue}'s original Observation / body text, with ONLY your appended block added at the end and no other issue's content). If either check fails — the title differs, the body no longer matches #${p.issue}, or a foreign Observation or a duplicate appended block is present — ABORT the write: do NOT run \`gh issue edit\`, and return { issue: ${p.issue}, parked: false, reason: "<which check failed>" } where the reason names the specific guard failure (e.g. "guard-abort: title mismatch", "guard-abort: body contaminated", "guard-abort: duplicate block") rather than the park reason, so the cause is legible. Only when both checks pass, write back: \`gh issue edit ${p.issue} --repo ${a.repo} --body-file body-${p.issue}.md\` (never hand-escape backticks or checklists).
4. Flip labels to the parked state: \`gh issue edit ${p.issue} --repo ${a.repo} --add-label cw-feedback:needs-input --remove-label cw-feedback:triaging\` (create cw-feedback:needs-input first if missing: color D93F0B). Do NOT add cw-feedback:go — that is the operator's action.
5. RELEASE the claim: parking hands the issue back to the operator, so delete this run's claim comment${p.plan.claim_comment_id ? ` (\`gh api -X DELETE repos/${a.repo}/issues/comments/${p.plan.claim_comment_id} 2>/dev/null || true\`)` : ' if one exists'}. Leaving it would make the next run (after the operator adds cw-feedback:go) see a stale live claim and yield.

Return structured output: { issue: ${p.issue}, parked: true, reason: "${reason}" } once the body is written, labels flipped, and the claim released (or parked: false with the mismatch cause if the guard aborted the write — in that case do NOT release the claim, the issue stays held).`;

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

const mergePrompt = (a, built, claimCommentId) => `You are merging one already-built PR to \`${a.defaultBranch}\` in repo ${a.repo}, headless, with no human. Several cw-ship/cw-sweep/cw-orchestrate runs may be merging to this branch concurrently — do NOT assume the default branch is quiescent; GitHub serializes the actual merge, and your job is to handle the "branch moved under me" outcome gracefully.

PR #${built.pr_number} (${built.pr_url}), branch \`${built.branch}\`, feedback #${built.issue}.

Steps:
1. \`git fetch origin ${a.defaultBranch} ${built.branch}\`.
2. PRE-MERGE CONFLICT CHECK against FRESH ${a.defaultBranch}: \`git merge-tree --write-tree --name-only origin/${a.defaultBranch} origin/${built.branch}\`. If it reports a conflict, do NOT merge: try ONE clean rebase of the branch onto fresh ${a.defaultBranch} and push with --force-with-lease; if it still conflicts or needs human judgment, report merged:false, cause "pre-merge conflict against ${a.defaultBranch}".
3. PRE-MERGE CI GATE — wait for green, THEN merge. NEVER merge over a pending or failing blocking check; \`--admin\` bypasses required-review, NOT in-progress or failing validation.
   a. Block until every check concludes: \`gh pr checks ${built.pr_number} --repo ${a.repo} --watch --interval 30\` (no \`queued\`/\`in_progress\` may remain). Then read final conclusions: \`gh pr checks ${built.pr_number} --repo ${a.repo}\`.
   b. BLOCKING checks — build, unit/integration tests, lint, vet, type/check, smoke builds, security scans — MUST every one conclude \`success\`. If ANY concluded \`failure\`/\`timed_out\`/\`startup_failure\`/\`action_required\`, do NOT merge: report \`merged:false\`, put their names in \`ci.failing_checks\`, set cause "pre-merge CI failed: <checks>". Do NOT fix it here (that is the build step's job) — the issue stays held with the failing check named.
   c. ADVISORY checks — coverage thresholds (\`codecov/patch\`, \`codecov/project\`) and preview/deploy checks — are soft gates per repo policy. A non-\`success\` advisory check does NOT block; record its name in \`ci.advisory_nonblocking\` and proceed. When unsure whether a check is blocking, treat it as BLOCKING; consult the repo's CLAUDE.md / AGENTS.md if it names required checks.
   d. A run \`cancelled\` by GitHub Actions \`concurrency: cancel-in-progress\` (a later commit landed while you waited) is NOT a failure — re-run \`--watch\` once to pick up the superseding run's conclusions before deciding. If checks never conclude within ~30 minutes, report \`merged:false\`, cause "pre-merge CI did not conclude (timeout)".
4. Only when every blocking check is green: \`gh pr merge ${built.pr_number} --repo ${a.repo} --squash --admin --delete-branch\`. If gh reports the PR is out of date / not mergeable because the base moved (another run merged first), that is EXPECTED under concurrency — re-fetch ${a.defaultBranch}, re-run the merge-tree check, rebase onto fresh ${a.defaultBranch} if needed, RE-RUN the pre-merge CI gate (step 3) on the rebased head, and retry the merge ONCE. Still failing → report merged:false, cause "base moved; needs rebase".
5. Verify and complete the terminal transition: PR state is MERGED; branch is gone (\`git ls-remote --heads origin ${built.branch}\` empty — if not, \`git push origin --delete ${built.branch}\`). The merge closes feedback #${built.issue} via the Closes line; confirm it is closed. Closing is a TERMINAL transition, so remove the in-flight claim label in the same step — cw-feedback:triaging and a closed/terminal state are mutually exclusive and a merged feedback issue must not keep the in-flight claim label: \`gh issue edit ${built.issue} --repo ${a.repo} --remove-label cw-feedback:triaging 2>/dev/null || true\`${claimCommentId ? `, then RELEASE this run's claim (\`gh api -X DELETE repos/${a.repo}/issues/comments/${claimCommentId} 2>/dev/null || true\`) — the issue is done` : ''}.
6. POST-MERGE sanity (regression detector only — the landing already passed the CI gate in step 3, so this rarely fires). Inspect the merge commit's checks (\`gh pr checks ${built.pr_number} --repo ${a.repo}\` / \`gh run list\`):
   - A run \`cancelled\` by \`concurrency: cancel-in-progress\` (a later commit landed on \`${a.defaultBranch}\` — another merge or an unrelated bot PR such as Renovate) is NOT a failure. Set \`ci.cancelled: true\`; confirm on the \`${a.defaultBranch}\` TIP and only record a genuinely-failed check in \`failing_checks\`.
   - Only a real \`failure\` conclusion on the merge commit (not advisory, not cancelled) goes in \`ci.failing_checks\`; it rides along as a post-merge regression WARNING on the merged issue, NOT an un-merge (the PR has already landed).

Merged = PR MERGED (the pre-merge gate already proved blocking CI green). Post-merge CI is advisory and never un-merges a landed PR. Never force-resolve a conflict; never merge over a pending or failing blocking check. If the merge does NOT land, leave cw-feedback:triaging and the claim in place — the issue stays held (its open PR is a stalled-but-live claim, not a crashed one).

Return structured output: { issue, merged, pr_state, branch_gone, ci: { failing_checks, advisory_nonblocking, cancelled, pending }, cause }.`;

const umbrellaPrompt = (a, p) => `You are filing a ready-to-orchestrate GitHub umbrella from an operator-APPROVED scope, using gh via Bash. Repo ${a.repo}. The operator added cw-feedback:go, so the scope below is settled — file it; do not re-ask.

Source feedback issue: ${p.url} (#${p.issue}). Approved scope (the operator may have edited the body; if the issue body's "## Proposed umbrella scope" differs from this, the BODY wins — re-read it first):
${JSON.stringify(p.plan.umbrella_scope, null, 2)}

Steps:
1. Re-read the feedback body for the operator's final scope edits: \`gh issue view ${p.issue} --repo ${a.repo} --json body\`.
2. File the umbrella issue. Body: a human "Why" (from the scope's why + the feedback), plus a dependencies section and acceptance — but NO sub-issue checklist; sub-issues are tracked as GitHub NATIVE sub-issues, linked in step 3. Mirror the cw-scope umbrella template shape. Capture the umbrella's node id (\`gh issue view <umb> --repo ${a.repo} --json id -q .id\`). Label it as the repo's umbrellas are labeled if such a label exists.
3. File each sub-issue at one-PR granularity with a body the cw-orchestrate readiness sweep can route "ready": What this is, Constraints (from AGENTS.md/CLAUDE.md), Acceptance (incl. regression tests). Then link each sub-issue to the umbrella as a NATIVE sub-issue (no checklist) — for each, in reading order: \`gh api graphql -f query='mutation($p:ID!,$c:ID!){addSubIssue(input:{issueId:$p,subIssueId:$c}){issue{number}}}' -f p=<umbrella node id> -f c=$(gh issue view <sub> --repo ${a.repo} --json id -q .id)\`.
4. Link back: add "Spawned from feedback #${p.issue}" to the umbrella body, and CLOSE the feedback issue with a comment "Tracked by umbrella #<n>; execution handed to cw-orchestrate." Remove its cw-feedback:triaging label, and RELEASE this run's claim${p.plan.claim_comment_id ? ` (\`gh api -X DELETE repos/${a.repo}/issues/comments/${p.plan.claim_comment_id} 2>/dev/null || true\`)` : ''} — the issue is handed off, not held.

Return structured output: { feedback_issue: ${p.issue}, umbrella, umbrella_url, sub_issues, cause }. Set umbrella=null with a cause if you could not file it (in that case leave cw-feedback:triaging and the claim in place — the issue is still held for a retry).`;

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
// Issues held by another run's still-live claim. A first-class outcome, distinct
// from an empty backlog: an --only run whose target is live-claimed lands here
// (not in `issues`), so the report says "held, auto-reclaims at <time>" instead of
// a bare empty result that previously read as "nothing to do" / "stranded".
const claimed_elsewhere = (discovered && discovered.claimed_elsewhere) || [];
// Issues carrying cw-feedback:hold that an --only run targeted directly. Out of
// scope for the loop (cataloged in the backlog until an operator swaps :hold ->
// :new), surfaced here so an --only run on a held target reports "on hold,
// skipped" instead of a bare empty result. Unscoped runs never see these.
const held = (discovered && discovered.held) || [];
log(
  `Discovered ${issues.length} open feedback issue(s) in scope` +
    (claimed_elsewhere.length ? `; ${claimed_elsewhere.length} held by another run (claimed_elsewhere)` : '') +
    (held.length ? `; ${held.length} on hold (skipped)` : '') +
    '.',
);
if (issues.length === 0) {
  return { repo: cfg.repo, planned: [], built: [], umbrellas_filed: [], escalations: [], yielded: [], claimed_elsewhere, held };
}

// --- Plan (claim + classify), one subagent per issue, in parallel ----------
phase('Plan');
const planResults = await parallel(
  issues.map((it) => () =>
    agent(planPrompt(cfg, it.issue, it.url, it.has_go, it.reclaim === true), {
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
const yielded = planned.filter((p) => dispositionFor(p.plan, p.hasGo) === 'skip').map((p) => p.issue);
log(
  `Planned: build=${queues.build.length} umbrella=${queues.umbrella.length} park=${queues.park.length}` +
    (yielded.length ? ` yielded=${yielded.length} (lost claim race: ${yielded.join(', ')})` : ''),
);

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
    const m = await agent(mergePrompt(cfg, b, p.plan.claim_comment_id), {
      label: `merge:${p.issue}`,
      phase: 'Resolve',
      schema: MERGE_SCHEMA,
    });
    // The PR lands only when the pre-merge CI gate passed. A merged PR is never
    // reported as not-merged: a genuine post-merge regression rides along as a
    // warning (the code is already on the default branch), it does not un-merge.
    const v = mergeVerdict(m);
    const merged = v.state === 'merged';
    built.push({ issue: p.issue, pr: b.pr_url || null, merged, cause: merged ? v.postMergeWarning : v.cause });
    log(
      `Build #${p.issue}: ${
        merged ? `merged${v.postMergeWarning ? ` (post-merge CI flagged: ${v.postMergeWarning})` : ''}` : `stalled — ${v.cause}`
      }`,
    );
  }
}

// --- Report ----------------------------------------------------------------
const report = {
  repo: cfg.repo,
  planned: planned.map((p) => ({ issue: p.issue, route: p.plan.route, disposition: dispositionFor(p.plan, p.hasGo) })),
  built,
  umbrellas_filed,
  escalations: escalations(planned),
  yielded, // issues this run claimed but another run owned — left for the owner, not double-built
  claimed_elsewhere, // discovery saw these in scope but live-claimed; never built — wait for reclaim_at
  held, // --only targets carrying cw-feedback:hold — out of scope; on hold, skipped
};
log(
  `Done. planned=${report.planned.length} merged=${report.built.filter((b) => b.merged).length}/${report.built.length} ` +
    `umbrellas=${report.umbrellas_filed.length} parked=${report.escalations.length} yielded=${report.yielded.length} ` +
    `claimed_elsewhere=${report.claimed_elsewhere.length} held=${report.held.length}`,
);
return report;
