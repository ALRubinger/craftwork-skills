// cw-orchestrate Workflow: plan -> review -> schedule -> work -> report.
//
// Launched by SKILL.md after the operator says "go", with `args` set to the
// manifest object (see references/manifest-schema.md). Runs headless in the
// background. The single human touchpoint (the readiness sweep) already
// completed in the main session; nothing here blocks on a human.
//
// Determinism: Workflow scripts forbid Date.now(), Math.random(), and argless
// `new Date()`. runId/timestamp arrive via the manifest; the scheduler is pure;
// all ordering is by issue number.
//
// The plan / review / work role prompts mirror references/subagent-roles.md and
// the merge contract mirrors references/merge-safety.md. Those files are the
// human-readable source of truth; the string constants below are what runs.

export const meta = {
  name: 'cw-orchestrate',
  description:
    'Take an umbrella issue’s sub-issues to merged PRs: per-node gated chain (plan + doc-review + work) that fires each node once its predecessors have merged, scheduled by declared deps and file-overlap, through a serialized, safety-gated squash-merge.',
  whenToUse:
    'After the cw-orchestrate readiness sweep, to run the hands-off per-node plan/review/schedule/work pipeline over a manifest.',
  phases: [
    { title: 'Plan', detail: 'plan subagent per node once its deps merged (parallel) -> plan + ownership table' },
    { title: 'Review', detail: 'doc-review per plan; P0 halts the sub-issue + dependents (skip planning); residuals filed' },
    { title: 'Schedule', detail: 'declared deps + file-overlap -> per-node eligibility as merges land (pure)' },
    { title: 'Work', detail: 'work subagent per eligible node (isolated worktree) -> PR' },
    { title: 'Merge', detail: 'serialized pre-merge merge-tree check -> squash-merge -> verify' },
    { title: 'Triage', detail: 'per merged node: classify its residual vs shipped code; close what is resolved/moot' },
    { title: 'Autofix', detail: 'final sweep: high-confidence FIX_NOW findings -> PR -> serial merge' },
    { title: 'Park', detail: 'write a "## Decision needed" block + needs-input label for residuals with judgment calls' },
  ],
};

// ---------------------------------------------------------------------------
// Structured-output schemas (see references/subagent-roles.md & merge-safety.md)
// ---------------------------------------------------------------------------

const OWNERSHIP_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['issue', 'plan_markdown', 'ownership_paths'],
  properties: {
    issue: { type: 'integer' },
    plan_markdown: { type: 'string', minLength: 1 },
    ownership_paths: { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1 },
  },
};

const REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['issue', 'p0', 'residuals'],
  properties: {
    issue: { type: 'integer' },
    p0: { type: 'boolean' },
    residuals: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['severity', 'title', 'detail'],
        properties: {
          severity: { type: 'string', enum: ['P0', 'P1', 'P2'] },
          title: { type: 'string', minLength: 1 },
          detail: { type: 'string', minLength: 1 },
        },
      },
    },
  },
};

const FILED_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['issue', 'residual_url'],
  properties: {
    issue: { type: 'integer' },
    residual_url: { type: ['string', 'null'] },
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
    // Titles of listed fixes the autofix subagent SKIPPED (too large/ambiguous to
    // land in scope). Non-empty => not every fix applied, so the residual stays
    // open even when triage disposition was close-via-autofix.
    skipped_fixes: { type: 'array', items: { type: 'string' } },
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

const TRIAGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['residual_issue', 'sub_issue', 'shipped', 'closed', 'findings'],
  properties: {
    residual_issue: { type: 'integer' },
    sub_issue: { type: 'integer' },
    shipped: { type: 'boolean' },
    closed: { type: 'boolean' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'verdict'],
        properties: {
          title: { type: 'string', minLength: 1 },
          severity: { type: 'string', enum: ['P0', 'P1', 'P2'] },
          verdict: { type: 'string', enum: ['RESOLVED', 'FIX_NOW', 'DECISION', 'MOOT'] },
          confidence: { type: 'string', enum: ['high', 'low'] },
          rationale: { type: 'string' },
          fix_hint: { type: ['string', 'null'] },
          // Required-in-prose on human-needed findings (DECISION / low-conf FIX_NOW):
          // the recommendation-first question shown inline and written into the park block.
          decision_question: { type: ['string', 'null'] },
          recommended_answer: { type: ['string', 'null'] },
          alt_options: { type: 'array', items: { type: 'string' } },
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
  },
};

// ---------------------------------------------------------------------------
// Pure scheduler — MIRROR of scheduler.mjs (kept in sync; tested there).
// A Workflow script cannot import sibling modules at runtime, so the canonical
// implementation is duplicated here verbatim. Do not edit one without the other.
// ---------------------------------------------------------------------------

function computeWaves(nodes) {
  const ids = nodes.map((n) => n.issue).sort((a, b) => a - b);
  const byId = new Map(nodes.map((n) => [n.issue, n]));

  // Directed edges as a Set of "a->b" strings.
  const edges = new Set();
  const addEdge = (a, b) => {
    if (a !== b) edges.add(`${a}->${b}`);
  };

  // 1. Logical edges: a dependency must land before its dependent.
  for (const n of nodes) {
    for (const dep of n.depends_on || []) {
      if (!byId.has(dep)) {
        throw new Error(`#${n.issue} depends_on unknown issue #${dep}`);
      }
      addEdge(dep, n.issue);
    }
  }

  // 2. File-overlap edges, lower-issue-first, only when the pair is not
  //    already ordered by a logical edge (in either direction).
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = ids[i];
      const b = ids[j];
      const pa = byId.get(a).ownership_paths || [];
      const pb = byId.get(b).ownership_paths || [];
      const overlaps = pa.some((p) => pb.includes(p));
      if (!overlaps) continue;
      if (edges.has(`${a}->${b}`) || edges.has(`${b}->${a}`)) continue;
      addEdge(a, b);
    }
  }

  // 3. Kahn layering into waves.
  const remaining = new Set(ids);
  const inDegreeWithin = (id) => {
    let count = 0;
    for (const e of edges) {
      const [src, dst] = e.split('->').map(Number);
      if (dst === id && remaining.has(src)) count++;
    }
    return count;
  };

  const waves = [];
  while (remaining.size > 0) {
    const wave = [...remaining]
      .filter((id) => inDegreeWithin(id) === 0)
      .sort((a, b) => a - b);
    if (wave.length === 0) {
      const stuck = [...remaining].sort((a, b) => a - b).join(', ');
      throw new Error(`dependency cycle detected among: ${stuck}`);
    }
    for (const id of wave) remaining.delete(id);
    waves.push(wave);
  }
  return waves;
}

function eligible(nodes, merged) {
  const mergedSet = new Set(merged);
  const ids = nodes.map((n) => n.issue).sort((a, b) => a - b);
  const byId = new Map(nodes.map((n) => [n.issue, n]));

  // Directed edges as a Set of "a->b" strings (a must land before b).
  const edges = new Set();
  const addEdge = (a, b) => {
    if (a !== b) edges.add(`${a}->${b}`);
  };
  for (const n of nodes) {
    for (const dep of n.depends_on || []) {
      if (byId.has(dep)) addEdge(dep, n.issue);
    }
  }
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = ids[i];
      const b = ids[j];
      const pa = byId.get(a).ownership_paths || [];
      const pb = byId.get(b).ownership_paths || [];
      if (!pa.some((p) => pb.includes(p))) continue;
      if (edges.has(`${a}->${b}`) || edges.has(`${b}->${a}`)) continue;
      addEdge(a, b);
    }
  }

  // A node is eligible iff it is not already merged and every predecessor is.
  const predecessorsMerged = (id) => {
    for (const e of edges) {
      const [src, dst] = e.split('->').map(Number);
      if (dst === id && !mergedSet.has(src)) return false;
    }
    return true;
  };
  return ids.filter((id) => !mergedSet.has(id) && predecessorsMerged(id));
}

function transitiveDependents(nodes, halted) {
  const ids = nodes.map((n) => n.issue).sort((a, b) => a - b);
  const byId = new Map(nodes.map((n) => [n.issue, n]));
  const edges = new Set();
  const addEdge = (a, b) => {
    if (a !== b) edges.add(`${a}->${b}`);
  };
  for (const n of nodes) {
    for (const dep of n.depends_on || []) {
      if (byId.has(dep)) addEdge(dep, n.issue);
    }
  }
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = ids[i];
      const b = ids[j];
      const pa = byId.get(a).ownership_paths || [];
      const pb = byId.get(b).ownership_paths || [];
      if (!pa.some((p) => pb.includes(p))) continue;
      if (edges.has(`${a}->${b}`) || edges.has(`${b}->${a}`)) continue;
      addEdge(a, b);
    }
  }

  const out = new Set(halted);
  const queue = [...halted];
  while (queue.length > 0) {
    const cur = queue.shift();
    for (const e of edges) {
      const [src, dst] = e.split('->').map(Number);
      if (src === cur && !out.has(dst)) {
        out.add(dst);
        queue.push(dst);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Pure triage-decision logic — MIRROR of triage.mjs (kept in sync; tested there).
// A Workflow script cannot import sibling modules at runtime, so the canonical
// implementation is duplicated here verbatim. Do not edit one without the other.
// See triage.mjs for the result shape and verdict semantics.
// ---------------------------------------------------------------------------

function closeDisposition(result) {
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

function highConfidenceFixes(result) {
  return ((result && result.findings) || []).filter(
    (f) => f.verdict === 'FIX_NOW' && f.confidence === 'high',
  );
}

function autofixCandidates(results) {
  return (results || [])
    .filter(Boolean)
    .filter((r) => highConfidenceFixes(r).length > 0)
    .map((r) => r.residual_issue)
    .sort((a, b) => a - b);
}

function escalations(results) {
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

function parkCandidates(results) {
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

function deferredResiduals(results) {
  return (results || [])
    .filter(Boolean)
    .filter((r) => r.shipped === false)
    .map((r) => r.residual_issue)
    .sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// Pure post-merge CI classification — MIRROR of merge-ci.mjs (tested there).
// A cancelled run (GitHub Actions concurrency cancel-in-progress, fired when a
// later commit lands on the default branch) is NOT a failure; only a real
// failing conclusion stalls a node. Do not edit one copy without the other.
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

// MIRROR of merge-ci.mjs mergeVerdict (tested there). A merged PR is never
// relabeled stalled; a post-merge regression rides along as a warning.
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
// Role prompt builders (mirror references/subagent-roles.md & merge-safety.md).
//
// planPrompt, workPrompt, mergePrompt, triagePrompt, and autofixPrompt are
// BYTE-FOR-BYTE mirrors of prompts.mjs (the tested canonical source);
// tests/mirror.test.mjs drift-guards them. Every run targets `defaultBranch`:
// plan/work/autofix fetch and branch off it, the squash-merge lands on it, and
// merge-tree checks the diff against it.
// ---------------------------------------------------------------------------

const planPrompt = (m, issue, briefText) => {
  return `You are planning a single GitHub sub-issue in a fresh context. You will NOT implement it; you produce a plan document and a file-ownership table.

Issue: #${issue.number} — ${issue.title} (repo ${m.repo}, default branch ${m.defaultBranch}).

Ground yourself in the code the work will fork from FIRST: \`git fetch origin ${m.defaultBranch} -q\` and read the relevant files at \`origin/${m.defaultBranch}\` HEAD (this is the branch the implementing subagent will branch off, so it already reflects any work earlier nodes have merged). Plan against that surface, not the launching worktree's HEAD.

Readiness brief (the operator's resolved decisions and constraints — authoritative; do not re-litigate):
\`\`\`
${briefText}
\`\`\`

Apply senior-engineer planning discipline: state key decisions, break the work into ordered implementation units (goal, files, approach, test scenarios, verification per unit), and call out scope boundaries. Honor every constraint in the brief. Where the brief names a pattern or file to mirror, follow it. Respect repo conventions (e.g. OpenAPI spec is source of truth; write endpoints carry approval gating and an idempotency flag).

Then enumerate the COMPLETE set of repo-relative paths your implementation will create or modify — source, generated, and test files. Be exhaustive and conservative: a path you will touch but omit becomes an undetected merge collision later. List a path even if only moderately sure. Do not list paths you are confident you will not touch.

Return structured output: { issue, plan_markdown, ownership_paths }.`;
};

const reviewPrompt = (m, issue, planMarkdown, briefText) => `You are doc-reviewing an implementation plan in a fresh context. Judge whether the plan is fit to execute hands-off, with no human gate between here and merge.

Issue #${issue.number} (umbrella #${m.umbrella}). Plan:
\`\`\`
${planMarkdown}
\`\`\`
Operator's brief (intent — the plan must serve this):
\`\`\`
${briefText}
\`\`\`

Classify findings by severity. A P0 is a finding that, if it ships, produces wrong, unsafe, or scope-violating work the operator would not have approved — a misread requirement, a missing safety/approval gate, a data-loss path, or a plan that contradicts the brief. Non-P0 findings are real but survivable.

Decide whether at least one P0 exists. List the residual findings (everything not trivially auto-fixable) so they can be filed as one tracked issue.

Return structured output: { issue, p0, residuals: [{severity, title, detail}] }.`;

const fileResidualPrompt = (m, issue, verdict) => `File ONE consolidated GitHub issue capturing deferred plan-review findings for sub-issue #${issue.number} (umbrella #${m.umbrella}), in repo ${m.repo}, using gh via Bash.

Findings (severity, title, detail):
${JSON.stringify(verdict.residuals, null, 2)}
This sub-issue ${verdict.p0 ? 'HAS a P0 and is halted pending operator triage' : 'has only non-P0 findings (file-and-proceed)'}.

Steps:
1. Ensure the label exists: \`gh label create cw-review-residual --repo ${m.repo} --color BFD4F2 --description "Deferred cw-orchestrate review findings" 2>/dev/null || true\`.
2. Create the issue with \`gh issue create --repo ${m.repo} --label cw-review-residual --title "cw-review-residual: plan findings for #${issue.number}" --body-file <(...)\`.
   Body must: link the sub-issue (\`Relates to #${issue.number}\`) and the umbrella (\`Umbrella #${m.umbrella}\`); list findings severity-first (P0 at top); and be structured so a future cw-orchestrate run can adopt it as a sub-issue (clear "What" and "Acceptance" sections).
3. Return the created issue URL.

Return structured output: { issue, residual_url }.`;

const workPrompt = (m, node) => {
  return `You are implementing one GitHub issue in an isolated git worktree, in a fresh context, with no human available. Take it from plan to an open, review-clean PR — do NOT merge; the orchestrator merges serially after you return.

Issue #${node.issue} (repo ${m.repo}, base ${m.defaultBranch}). Plan:
\`\`\`
${node.plan_markdown}
\`\`\`

Steps:
1. Create a branch off fresh \`${m.defaultBranch}\` in your worktree.
2. Implement the plan. Follow repo conventions (AGENTS.md/CLAUDE.md): regenerate generated files rather than hand-editing; write tests for new behavior; keep coverage above the repo bar.
3. Run the repo's build + test suite. Tests must pass before you open a PR.
4. Open a PR and push the branch. Conventional-commit title; the body has a Summary and a Test plan AND MUST include a \`Closes #${node.issue}\` line on its own line so the squash-merge auto-closes the sub-issue. Do not omit it — the orchestrator reconciles issue state afterward, but the closing keyword is what makes the common path self-closing.
5. Run a code-review pass on your own diff. A P0 is a correctness/security/data-loss/scope finding that must not merge. Fix and re-review if you can; if a P0 cannot be safely auto-fixed here, leave the PR open and report p0:true — do NOT signal ready_to_merge.
6. Report the PR number/URL, branch, the files you actually changed, and your verdict.

If you cannot reach green build + passing tests + clean review, report ready_to_merge:false with the cause rather than papering over it.

Return structured output: { issue, ready_to_merge, p0, pr_number, pr_url, branch, changed_paths, cause }.`;
};

const mergePrompt = (m, built) => {
  const fetchRefs = [m.defaultBranch, built.branch].join(' ');
  return `You are performing a SERIALIZED merge of one already-built PR to \`${m.defaultBranch}\` in repo ${m.repo}, headless, with no human. Only one merge runs at a time; you are it right now.

PR #${built.pr_number} (${built.pr_url}), branch \`${built.branch}\`, issue #${built.issue}.

Steps (see references/merge-safety.md):
1. \`git fetch origin ${fetchRefs}\`.
2. PRE-MERGE CONFLICT CHECK against FRESH ${m.defaultBranch}: run \`git merge-tree --write-tree --name-only origin/${m.defaultBranch} origin/${built.branch}\`. If it reports a conflict, do NOT merge: try ONE clean rebase of the branch onto fresh ${m.defaultBranch} and push with --force-with-lease; if it still conflicts or needs human judgment, report merged:false, cause "pre-merge conflict against ${m.defaultBranch}".
3. PRE-MERGE CI GATE — wait for green, then merge. NEVER merge over a pending or failing blocking check; \`--admin\` bypasses required-review, NOT in-progress or failing validation.
   a. Block until every check concludes: \`gh pr checks ${built.pr_number} --repo ${m.repo} --watch --interval 30\` (no \`queued\`/\`in_progress\` may remain). Then read final conclusions: \`gh pr checks ${built.pr_number} --repo ${m.repo}\`.
   b. BLOCKING checks — build, unit/integration tests, lint, vet, type/Svelte check, smoke builds, security scans — MUST every one conclude \`success\`. If ANY concluded \`failure\`/\`timed_out\`/\`startup_failure\`/\`action_required\`, do NOT merge: report \`merged:false\`, put their names in \`ci.failing_checks\`, set cause "pre-merge CI failed: <checks>". Do NOT fix it here (that is the work step's job) — the node stalls for the operator with the failing check named.
   c. ADVISORY checks — coverage thresholds (\`codecov/patch\`, \`codecov/project\`) and preview/deploy checks (e.g. a Railway \`… - docs\` deployment reporting \`cancelled\`) — are soft gates per repo policy. A non-\`success\` advisory check does NOT block; record its name in \`ci.advisory_nonblocking\` and proceed. When unsure whether a check is blocking, treat it as BLOCKING; consult the repo's CLAUDE.md / AGENTS.md if it names required checks.
   d. If checks never conclude within ~30 minutes, report \`merged:false\`, cause "pre-merge CI did not conclude (timeout)".
4. Only when every blocking check is green: \`gh pr merge ${built.pr_number} --repo ${m.repo} --squash --admin --delete-branch\`.
5. Verify: PR state is MERGED (\`gh pr view ${built.pr_number} --repo ${m.repo} --json state\`); branch is gone (\`git ls-remote --heads origin ${built.branch}\` empty — if not, \`git push origin --delete ${built.branch}\`). Report \`merged: true\`.
6. POST-MERGE sanity (regression detector only — the landing already passed CI in step 3, so this rarely fires). Inspect the merge commit's checks (\`gh pr checks ${built.pr_number} --repo ${m.repo}\` / \`gh run list\`):
   - A run \`cancelled\` by GitHub Actions \`concurrency: cancel-in-progress\` (a later commit landed on \`${m.defaultBranch}\` — the next serialized node or an unrelated bot PR such as Renovate) is NOT a failure. Set \`ci.cancelled: true\`; confirm on the \`${m.defaultBranch}\` TIP and only record a genuinely-failed check in \`failing_checks\`.
   - Only a real \`failure\` conclusion on the merge commit (not advisory, not cancelled) goes in \`ci.failing_checks\`; it is surfaced as a post-merge regression warning on the merged node, NOT a stall (the PR has merged).

Never force-resolve a conflict. Never merge over a pending or failing blocking check.

Return structured output: { issue, merged, pr_state, branch_gone, ci: { failing_checks, advisory_nonblocking, cancelled, pending }, cause }.`;
};

const triagePrompt = (m, subIssue, residualUrl, prHint) => {
  return `You are triaging a "cw-review-residual" issue against the SHIPPED code, headless, with no human. These residuals were filed against an implementation PLAN; your job is to re-judge each finding against what actually merged, then act on the cheap/clear ones and leave only genuine judgment calls for a human.

Repo ${m.repo}, default branch ${m.defaultBranch}.
Residual issue: ${residualUrl}
Tracks sub-issue: #${subIssue}${prHint ? `\nThe sub-issue merged via: ${prHint}` : ''}

Steps:
1. Read the residual issue body (\`gh issue view ${residualUrl} --json title,body\`) and extract its findings.
2. Establish whether the sub-issue #${subIssue} has SHIPPED: confirm its closing PR is MERGED${prHint ? ` (${prHint})` : ` (\`gh issue view ${subIssue} --repo ${m.repo} --json state,closedByPullRequestsReferences\`, then verify that PR is MERGED)`}. If it has NOT shipped (open/halted, no merged PR), set shipped:false, mark every finding verdict "DECISION" with rationale "sub-issue not yet shipped; cannot triage against code", do NOT close the residual, and return. A future run triages it once the feature lands.
3. If shipped, read the merged diff (\`gh pr diff <pr> --repo ${m.repo}\`) and the current files on ${m.defaultBranch}. For EACH finding, classify against the shipped code:
   - RESOLVED — the merged code already does the right thing. Cite the file/line that proves it.
   - FIX_NOW  — a real, small, unambiguous fix. Set confidence "high" only if you are sure the fix is correct, safe, and in-scope (it will be applied and merged with NO human review). If there is any ambiguity about correctness, scope, or approach, set confidence "low".
   - DECISION — needs a human judgment call (a real trade-off, a product/behavior choice, or a fix whose correct form is unclear). Never use this as a dumping ground; reserve it for genuine choices.
   - MOOT     — the finding was wrong, or the implementation diverged so it no longer applies.
   For EVERY finding you mark DECISION or low-confidence FIX_NOW (i.e. anything that will reach a human), ALSO set these so the operator can be asked with a recommendation-first prompt and the decision can be parked verbatim:
     - decision_question  — one crisp line stating the choice the operator must make (outcome-framed, not implementation minutiae).
     - recommended_answer — your single best answer (becomes the first, "(Recommended)" option). Make a real call; only say it's a toss-up if it genuinely is.
     - alt_options        — 1-3 realistic alternative answers, each a short outcome-framed label.
   Leave these null/empty on RESOLVED, MOOT, and high-confidence FIX_NOW findings.
4. Post ONE triage comment on the residual summarizing each finding's verdict + one-line rationale (\`gh issue comment ${residualUrl} --body-file <(...)\`).
5. CLOSE the residual ONLY if every finding is RESOLVED or MOOT (no action remains): \`gh issue close ${residualUrl} --comment "Triaged: all findings resolved in shipped code or moot. <one line>"\` and set closed:true. Otherwise leave it open (high-confidence FIX_NOW findings are auto-fixed in a later sweep; DECISION / low-confidence findings await a human) and set closed:false.

Be conservative about closing and about high-confidence: closing a real issue or auto-merging a wrong fix is worse than leaving a residual open for a human.

Return structured output: { residual_issue, sub_issue, shipped, closed, findings: [{title, severity, verdict, confidence, rationale, fix_hint, decision_question, recommended_answer, alt_options}] }.`;
};

// decisionFindings + parkResidualPrompt — BYTE-FOR-BYTE mirror of prompts.mjs
// (mirror.test.mjs renders both and asserts equality). They drive the in-run PARK
// step: the headless analog of the autofix sweep. After triage, each
// parkCandidates() residual gets a "## Decision needed" block written into its body
// + the cw-review-residual:needs-input label, so a standalone cw-resolve skill run (which
// queries --label cw-review-residual:needs-input) can discover and drain it.
const decisionFindings = (tr) =>
  ((tr && tr.findings) || []).filter(
    (f) => f.verdict === 'DECISION' || (f.verdict === 'FIX_NOW' && f.confidence !== 'high'),
  );

const parkResidualPrompt = (m, tr, residualUrl) => `You are PARKING one cw-review-residual issue for the operator's input, using gh via Bash. Repo ${m.repo}. Residual: ${residualUrl} (#${tr.residual_issue}, feature #${tr.sub_issue}). Its findings against the shipped code include genuine judgment calls only the operator should make.

Steps:
1. Fetch the current body into a private temp dir (write all scratch here, never into the working checkout): \`D=\"\$(mktemp -d)\"; gh issue view ${tr.residual_issue} --repo ${m.repo} --json body -q .body > \"\$D/body.md\"\`.
2. Write the decisions into \"\$D/body.md\" as a "## Decision needed" block — one numbered entry per decision below, each showing the question, your recommended answer, and the alternatives. Each entry MUST carry an "**Answer:** " line (left blank for the operator to fill) so the cw-resolve skill can parse and write the answer back. If a "## Decision needed" block already exists (a prior park), REPLACE it in place rather than appending a second one. The decisions:
\`\`\`json
${JSON.stringify(
  decisionFindings(tr).map((f) => ({
    question: f.decision_question || f.title,
    recommended: f.recommended_answer || null,
    alternatives: f.alt_options || [],
  })),
  null,
  2,
)}
\`\`\`
   End the block with: "_To proceed: answer each decision inline above, then add the \\\`cw-review-residual:go\\\` label (or invoke the cw-resolve skill). The next cw-sweep run applies your answers._"
   Use \`gh issue edit ${tr.residual_issue} --repo ${m.repo} --body-file \"\$D/body.md\"\` (never hand-escape backticks or checklists).
3. Flip labels to the parked state: \`gh issue edit ${tr.residual_issue} --repo ${m.repo} --add-label cw-review-residual:needs-input --remove-label cw-review-residual:go\` (create cw-review-residual:needs-input first if missing: color D93F0B). Do NOT add cw-review-residual:go — that is the operator's action.

Return structured output: { issue: ${tr.residual_issue}, parked: true }.`;

const autofixPrompt = (m, tr) => {
  return `You are implementing ONLY a set of small, high-confidence cleanup fixes for cw-review-residual #${tr.residual_issue} (sub-issue #${tr.sub_issue}) in an isolated git worktree, headless, with no human. Do NOT merge; the orchestrator merges serially after you return.

Repo ${m.repo}, base ${m.defaultBranch}. Implement EXACTLY these triaged fixes and nothing more:
\`\`\`json
${JSON.stringify(highConfidenceFixes(tr).map((f) => ({ title: f.title, fix_hint: f.fix_hint, rationale: f.rationale })), null, 2)}
\`\`\`

FRESHNESS PRE-CHECK — do this FIRST, before branching or writing any code. The triage that produced these fixes is a snapshot and may be stale: between triage and now, a parallel PR or another session can close the residual or land an equivalent fix on \`${m.defaultBranch}\`. Building a PR for already-done work burns a PR + CI cycle for nothing — this check prevents exactly that.
- a. Confirm the residual is still OPEN: \`gh issue view ${tr.residual_issue} --repo ${m.repo} --json state,closedByPullRequestsReferences\`. If it is CLOSED, STOP: do not branch or open a PR; report ready_to_merge:false, cause "residual #${tr.residual_issue} already closed since triage".
- b. \`git fetch origin ${m.defaultBranch} -q\`, then for each listed fix read the file(s) it would touch at fresh \`origin/${m.defaultBranch}\` HEAD and DROP any whose change is already present (an equivalent guard/test/code merged since triage — search for the symbol/test name, do not assume). If EVERY listed fix is already on \`${m.defaultBranch}\`, STOP: report ready_to_merge:false, cause "fixes already landed on ${m.defaultBranch} (equivalent work merged since triage)". Otherwise proceed with ONLY the fixes that are genuinely still needed.

Steps:
1. Branch off fresh \`${m.defaultBranch}\` in your worktree.
2. Implement ONLY the listed fixes. Stay strictly in scope. If a "fix" turns out to be larger, ambiguous, or riskier than its description, SKIP it and record it in \`skipped_fixes\` (the fix's title) plus a note in \`cause\` rather than expanding scope or guessing — a skipped fix is fine; an over-reaching one is not. Skipping ANY listed fix means the residual is NOT fully resolved, so step 4 must keep it open.
3. Follow repo conventions (AGENTS.md/CLAUDE.md): regenerate generated files rather than hand-editing; add or extend tests for changed behavior; keep coverage above the repo bar. Run the build + test suite; tests must pass before you open a PR.
4. Open a PR. Conventional-commit title (\`fix\`/\`test\`/\`docs\`/\`chore\` scope as fits). Body: Summary + Test plan. ${closeDisposition(tr) === 'close-via-autofix' ? `These fixes are the residual's only remaining actionable findings, so it closes only when they ALL land: if you applied EVERY listed fix (\`skipped_fixes\` is empty), include \`Closes #${tr.residual_issue}\` on its own line; if you SKIPPED any fix (per step 2), include \`Relates to #${tr.residual_issue}\` INSTEAD and do NOT close it — the skipped fix is unfinished work, so the residual must stay open for the next sweep.` : `Include \`Relates to #${tr.residual_issue}\` on its own line. Do NOT close it: unresolved DECISION/low-confidence findings remain for a human.`} Push the branch.
5. Run a code-review pass on your own diff. A P0 is a correctness/security/data-loss/scope finding that must not merge. Fix and re-review if you can; if a P0 cannot be safely auto-fixed here, leave the PR open and report p0:true.
6. Report issue=${tr.residual_issue}, the PR number/URL, branch, files changed, the titles of any fixes you skipped (\`skipped_fixes\`), and your verdict.

If you cannot reach green build + passing tests + clean review, report ready_to_merge:false with the cause rather than papering over it.

Return structured output: { issue, ready_to_merge, p0, pr_number, pr_url, branch, changed_paths, cause, skipped_fixes }.`;
};

// ---------------------------------------------------------------------------
// Orchestration body
// ---------------------------------------------------------------------------

// The Workflow runtime delivers `args` to the script as a JSON *string*, not a
// pre-parsed object — parse it here. Tolerate an already-parsed object too, so
// the script is correct regardless of how the host marshals `args`.
let manifest = args;
if (typeof manifest === 'string') {
  try {
    manifest = JSON.parse(manifest);
  } catch (e) {
    throw new Error(`cw-orchestrate: manifest (args) is a string but not valid JSON: ${e.message}`);
  }
}
if (!manifest || !Array.isArray(manifest.issues) || manifest.issues.length === 0) {
  throw new Error('cw-orchestrate: manifest (args) missing or has no issues');
}
if (!manifest.runId || !manifest.timestamp) {
  throw new Error('cw-orchestrate: manifest must carry runId and timestamp (Workflow determinism)');
}

// Read each brief from its absolute path via a tiny reader subagent (the script
// itself has no filesystem access). Done once, in parallel.
phase('Plan');
log(`Run ${manifest.runId}: umbrella #${manifest.umbrella}, ${manifest.issues.length} issue(s)`);

const BRIEF_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['issue', 'brief_text'],
  properties: { issue: { type: 'integer' }, brief_text: { type: 'string' } },
};

const briefs = await parallel(
  manifest.issues.map((it) => () =>
    agent(
      `Read the file at the absolute path "${it.brief_path}" with the Read tool and return its full text verbatim as brief_text, with issue ${it.number}. If the file does not exist, return brief_text "MISSING BRIEF".`,
      { label: `brief:${it.number}`, phase: 'Plan', schema: BRIEF_SCHEMA },
    ),
  ),
);
const briefText = new Map((briefs.filter(Boolean)).map((b) => [b.issue, b.brief_text]));

// ---------------------------------------------------------------------------
// Per-node gated execution: each node's plan -> review -> file-residual -> work
// -> merge defers until ALL its predecessors have MERGED onto the target. Unlike
// the old plan-all-up-front + barrier-wave model, a same-run dependent now plans
// AGAINST its prerequisite's merged output (the planPrompt forks origin/<target>,
// which the prerequisite has already landed on by the time the dependent fires).
// Eligible nodes plan + work in PARALLEL; only the merge step is serialized (the
// merge lock — one PR touches the target at a time). The pure scheduler stays
// canonical: `eligible(nodes, merged)` mirrors `computeWaves`'s edge model and
// answers "which not-yet-merged node has every predecessor merged?".
// ---------------------------------------------------------------------------

// Declared deps from the manifest. File-overlap edges are discovered later from
// the plans' ownership tables; declared deps are the only edges known up front,
// so they alone gate PLANNING (planning is read-only — two nodes may plan even if
// they will contend on a file; that contention is a MERGE concern caught by the
// serial merge lock + pre-merge merge-tree check).
const declaredDepsByIssue = new Map(manifest.issues.map((it) => [it.number, it.depends_on || []]));
const issueByNumber = new Map(manifest.issues.map((it) => [it.number, it]));

// Up-front cycle / unknown-target validation of the declared-dep graph, matching
// Step 3's promise (the scheduler re-checks, but catch it before any work fires).
// File-overlap never forms a cycle (oriented lower-issue-first), so the declared
// graph is the only cycle source; computeWaves throws on a cycle or unknown dep.
const declaredNodes = manifest.issues.map((it) => ({
  issue: it.number,
  ownership_paths: [],
  depends_on: declaredDepsByIssue.get(it.number) || [],
}));
let scheduleError = null;
try {
  computeWaves(declaredNodes);
} catch (e) {
  scheduleError = String(e && e.message ? e.message : e);
  log(`Schedule failed: ${scheduleError}`);
}

// Mutable run state. `planned` accumulates planned nodes (with ownership_paths,
// p0, residuals, residual_url); `status` records terminal merged/stalled; the
// merged set drives both gates.
const planByIssue = new Map(); // issue -> planned node
const status = new Map(); // issue -> { state: 'merged'|'stalled', pr?, cause? }
const mergedSet = new Set(); // issues merged onto the target
const startedPlan = new Set(); // issues whose plan chain has been dispatched

// In-run triage: the moment a node merges, its residual can be re-judged against
// the now-shipped code. Fire triage WITHOUT awaiting it here so it does not hold
// the merge lock; each triage only reads its own merged diff, so it is safe to
// run concurrently with later work/merges. Collected and awaited after the loop.
const triagePromises = [];
const triageOne = (subIssue, residualUrl, prUrl) =>
  agent(triagePrompt(manifest, subIssue, residualUrl, prUrl), {
    label: `triage:${subIssue}`,
    phase: 'Triage',
    schema: TRIAGE_SCHEMA,
  });

const isTerminal = (issue) => status.has(issue); // merged or stalled

// Plan -> review -> file-residual for one issue (the deferred head of its chain).
const planChain = async (it) => {
  const plan = await agent(planPrompt(manifest, it, briefText.get(it.number) || 'MISSING BRIEF'), {
    label: `plan:${it.number}`,
    phase: 'Plan',
    schema: OWNERSHIP_SCHEMA,
  });
  let node = { ...it, ...plan };
  const verdict = await agent(
    reviewPrompt(manifest, it, node.plan_markdown, briefText.get(it.number) || ''),
    { label: `review:${it.number}`, phase: 'Review', schema: REVIEW_SCHEMA },
  );
  node = { ...node, p0: verdict.p0, residuals: verdict.residuals };
  if (node.residuals && node.residuals.length > 0) {
    const filed = await agent(fileResidualPrompt(manifest, it, node), {
      label: `residual:${it.number}`,
      phase: 'Review',
      schema: FILED_SCHEMA,
    });
    node = { ...node, residual_url: filed.residual_url };
  } else {
    node = { ...node, residual_url: null };
  }
  return node;
};

// Merge one already-built node (serialized — only ever called one at a time).
const mergeOne = async (b) => {
  if (!b.ready_to_merge || b.p0) {
    status.set(b.issue, {
      state: 'stalled',
      cause: b.p0 ? 'P0 code-review on the diff; PR left open' : b.cause || 'build did not reach a mergeable state',
      pr: b.pr_url || null,
    });
    return;
  }
  const m = await agent(mergePrompt(manifest, b), {
    label: `merge:${b.issue}`,
    phase: 'Merge',
    schema: MERGE_SCHEMA,
  });
  const v = mergeVerdict(m);
  if (v.state === 'merged') {
    // The PR landed (pre-merge CI gated it green). A genuine post-merge
    // regression rides along as a warning; it does not stall the node or halt
    // dependents (the code is already on the target).
    mergedSet.add(b.issue);
    status.set(b.issue, { state: 'merged', pr: b.pr_url || null, postMergeWarning: v.postMergeWarning });
    log(`#${b.issue} merged.${v.postMergeWarning ? ` (post-merge CI flagged: ${v.postMergeWarning})` : ''}`);
    const residualUrl = planByIssue.get(b.issue)?.residual_url;
    if (residualUrl) triagePromises.push(triageOne(b.issue, residualUrl, b.pr_url || null));
  } else {
    // Did NOT land: pre-merge conflict, a failing blocking check, or a gate
    // timeout. A true stall for the operator.
    status.set(b.issue, { state: 'stalled', cause: v.cause, pr: b.pr_url || null });
    log(`#${b.issue} stalled: ${v.cause}`);
  }
};

// The driver loop. Each pass: (1) cascade stalls to dependents, (2) plan every
// newly plan-eligible node in parallel, (3) work every work-eligible planned node
// in parallel, (4) merge the built nodes serially. Repeat until nothing more can
// advance. A pass that does no work breaks the loop (guards against a stuck graph).
if (!scheduleError) {
  for (;;) {
    // (1) Cascade: any node whose plan flagged a P0, or that stalled in build/
    //     merge, halts its transitive dependents — which now SKIP PLANNING too,
    //     not just work. Seeds = P0-reviewed planned nodes ∪ stalled nodes; the
    //     edge model uses the ownership paths known so far (planned nodes).
    const knownNodes = manifest.issues.map((it) => ({
      issue: it.number,
      ownership_paths: planByIssue.get(it.number)?.ownership_paths || [],
      depends_on: declaredDepsByIssue.get(it.number) || [],
    }));
    const p0Seeds = [...planByIssue.values()].filter((n) => n.p0).map((n) => n.issue);
    const stalledSeeds = [...status.entries()].filter(([, s]) => s.state === 'stalled').map(([i]) => i);
    const haltedSet = transitiveDependents(knownNodes, [...new Set([...p0Seeds, ...stalledSeeds])]);
    for (const issue of haltedSet) {
      if (isTerminal(issue)) continue;
      const planNode = planByIssue.get(issue);
      if (planNode && planNode.p0) {
        status.set(issue, { state: 'stalled', cause: 'P0 plan review finding; withheld pending operator triage' });
      } else {
        status.set(issue, { state: 'stalled', cause: 'dependency halted (depends on a halted/stalled sub-issue); not started' });
      }
    }

    // (2) PLAN gate: declared-dep predecessors merged ⇒ eligible to plan. Strip
    //     ownership paths so only declared-dep edges apply (file-overlap doesn't
    //     gate read-only planning). Skip terminal/halted/already-started nodes.
    const planEligible = eligible(declaredNodes, mergedSet).filter(
      (issue) => !isTerminal(issue) && !startedPlan.has(issue),
    );
    if (planEligible.length > 0) {
      for (const issue of planEligible) startedPlan.add(issue);
      const newlyPlanned = await parallel(
        planEligible.map((issue) => () => planChain(issueByNumber.get(issue))),
      );
      for (const n of newlyPlanned.filter(Boolean)) planByIssue.set(n.issue, n);
      // A freshly-planned P0 halts dependents on the NEXT pass (cascade above).
      continue;
    }

    // (3) WORK gate: full edge model (declared deps ∪ file-overlap) over the
    //     known nodes — declared-dep predecessors that are not yet planned still
    //     block (their edge persists with empty paths); file-overlap among
    //     planned nodes serializes known contenders. Eligible ⇒ planned, not
    //     terminal/halted, not already built.
    const workEligible = eligible(knownNodes, mergedSet).filter(
      (issue) => planByIssue.has(issue) && !isTerminal(issue) && !haltedSet.has(issue),
    );
    if (workEligible.length === 0) break; // nothing left to advance

    phase('Work');
    const built = await parallel(
      workEligible.map((issue) => () =>
        agent(workPrompt(manifest, planByIssue.get(issue)), {
          label: `work:${issue}`,
          phase: 'Work',
          isolation: 'worktree',
          schema: BUILD_SCHEMA,
        }),
      ),
    );

    // (4) Serial merge loop = the merge lock. One node merges at a time, in a
    //     stable ascending order. A merge advances mergedSet, unblocking gated
    //     dependents on the next pass.
    for (const b of built.filter(Boolean).sort((x, y) => x.issue - y.issue)) {
      await mergeOne(b);
    }
    // Any work-eligible node whose subagent returned nothing → stalled.
    for (const issue of workEligible) {
      if (!isTerminal(issue)) status.set(issue, { state: 'stalled', cause: 'work subagent returned no result' });
    }
  }
}

const planned = [...planByIssue.values()];
const residualsReport = planned
  .filter((n) => n.residual_url)
  .map((n) => ({ issue: n.issue, url: n.residual_url, p0: !!n.p0 }));

// ---------------------------------------------------------------------------
// Triage — collect the per-node triage results fired as each node merged.
// Each classified its residual against the shipped code and closed the ones with
// nothing actionable left (close-now); residuals with remaining work stay open.
// ---------------------------------------------------------------------------
phase('Triage');
const triageResults = (await Promise.all(triagePromises)).filter(Boolean);
if (triagePromises.length > 0) {
  const closedCount = triageResults.filter((t) => t.closed).length;
  log(`Triaged ${triageResults.length} residual(s); closed ${closedCount}.`);
}

// ---------------------------------------------------------------------------
// Autofix — final sweep over a now-quiescent default branch. Nothing else is
// merging, so applying residual fixes here cannot collide with unmerged siblings.
// Only high-confidence FIX_NOW findings qualify (autofixCandidates); each such
// residual gets one PR, serial-merged via the same merge contract.
// ---------------------------------------------------------------------------
phase('Autofix');
const autofixed = [];
const autofixQueue = autofixCandidates(triageResults);
for (const residualIssue of autofixQueue) {
  const tr = triageResults.find((t) => t.residual_issue === residualIssue);
  const built = await agent(autofixPrompt(manifest, tr), {
    label: `autofix:${residualIssue}`,
    phase: 'Autofix',
    isolation: 'worktree',
    schema: BUILD_SCHEMA,
  });
  if (!built || !built.ready_to_merge || built.p0) {
    autofixed.push({
      residual_issue: residualIssue,
      pr: built?.pr_url || null,
      merged: false,
      cause: built?.p0 ? 'P0 on autofix diff; PR left open' : built?.cause || 'autofix build not mergeable',
      skipped_fixes: built?.skipped_fixes || [],
      residual_closed: false,
    });
    continue;
  }
  const mResult = await agent(mergePrompt(manifest, built), {
    label: `autofix-merge:${residualIssue}`,
    phase: 'Autofix',
    schema: MERGE_SCHEMA,
  });
  // The landing is gated green pre-merge (mergePrompt step 3). merged tracks the
  // landing; a post-merge regression is a warning, never a flip back to false.
  const v = mergeVerdict(mResult);
  const merged = v.state === 'merged';
  const cause = merged ? v.postMergeWarning : v.cause;
  // A skipped fix means the autofix PR only Relates-to the residual, so it stays
  // open even though triage disposition was close-via-autofix. Surface both so the
  // report can tell "closed, all applied" from "kept-open, some skipped".
  const skipped = built.skipped_fixes || [];
  const residualClosed = merged && closeDisposition(tr) === 'close-via-autofix' && skipped.length === 0;
  autofixed.push({
    residual_issue: residualIssue,
    pr: built.pr_url || null,
    merged,
    cause,
    skipped_fixes: skipped,
    residual_closed: residualClosed,
  });
  log(
    `Autofix #${residualIssue}: ${merged ? 'merged' : 'stalled — ' + cause}` +
      (skipped.length ? ` (residual kept open; ${skipped.length} fix(es) skipped)` : ''),
  );
}

// ---------------------------------------------------------------------------
// Park decisions: write the "## Decision needed" block + needs-input label.
// The headless analog of autofix — each shipped residual with a remaining judgment
// call (DECISION or low-confidence FIX_NOW) is parked to the cw-resolve inbox so a
// standalone cw-resolve skill run (querying --label cw-review-residual:needs-input) can drain
// it. Escalations stay in the report too (this is the durable park, not a
// replacement). Unshipped residuals defer (deferredResiduals), never park. Runs
// after autofix: a residual carrying a parkable finding is keep-open, so its autofix
// PR (if any) only Relates-to and leaves the residual open to park.
// ---------------------------------------------------------------------------
phase('Park');
const parked = [];
const parkQueue = parkCandidates(triageResults);
log(`Park queue: ${parkQueue.length} residual(s) with judgment calls.`);
if (parkQueue.length) {
  const parkResults = await parallel(
    parkQueue.map((residualIssue) => () => {
      const tr = triageResults.find((t) => t.residual_issue === residualIssue);
      const url = `https://github.com/${manifest.repo}/issues/${residualIssue}`;
      return agent(parkResidualPrompt(manifest, tr, url), {
        label: `park:${residualIssue}`,
        phase: 'Park',
        schema: PARK_SCHEMA,
      });
    }),
  );
  for (const p of parkResults.filter(Boolean)) {
    if (p.parked) parked.push(p.issue);
  }
}

// ---------------------------------------------------------------------------
// Report (R18)
// ---------------------------------------------------------------------------
const report = {
  umbrella: manifest.umbrella,
  runId: manifest.runId,
  scheduleError,
  merged: [],
  stalled: [],
  residuals: residualsReport,
  triaged: triageResults.map((t) => ({
    residual_issue: t.residual_issue,
    sub_issue: t.sub_issue,
    shipped: t.shipped !== false,
    closed: !!t.closed,
    disposition: closeDisposition(t),
  })),
  autofixed,
  parked: parked.sort((a, b) => a - b),
  escalations: escalations(triageResults),
  deferred_residuals: deferredResiduals(triageResults),
};
for (const [issue, s] of [...status.entries()].sort((a, b) => a[0] - b[0])) {
  if (s.state === 'merged') report.merged.push({ issue, pr: s.pr || null, post_merge_warning: s.postMergeWarning || null });
  else report.stalled.push({ issue, cause: s.cause || 'unknown', pr: s.pr || null });
}
// Any manifest issue that never reached a terminal state (e.g. a declared-dep
// cycle stopped the loop before it could fire) → stalled, so the report accounts
// for every sub-issue in scope.
for (const it of manifest.issues) {
  if (!status.has(it.number)) {
    report.stalled.push({ issue: it.number, cause: scheduleError ? 'not scheduled (schedule error)' : 'not processed', pr: null });
  }
}

log(
  `Done. merged=${report.merged.length} stalled=${report.stalled.length} ` +
    `residuals=${report.residuals.length} triaged=${report.triaged.length} ` +
    `autofixed=${report.autofixed.filter((a) => a.merged).length}/${report.autofixed.length} ` +
    `parked=${report.parked.length} escalations=${report.escalations.length} deferred=${report.deferred_residuals.length}`,
);
return report;
