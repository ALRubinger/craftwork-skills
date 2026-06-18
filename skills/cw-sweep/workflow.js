// cw-sweep Workflow: discover -> triage (classify + close) -> autofix.
//
// Launched by SKILL.md with `args` = { repo, defaultBranch, umbrella?, only?,
// autofix }. Runs headless in the background. Clears the backlog of open
// `review-residual` issues that cw-orchestrate files: re-judges each
// finding against the SHIPPED code, closes what is resolved/moot, optionally
// auto-applies high-confidence fixes, and surfaces only genuine judgment calls.
//
// Determinism: Workflow scripts forbid Date.now(), Math.random(), and argless
// `new Date()`. This skill mints no timestamps and writes no scratch.
//
// The triage / autofix role prompts mirror references/residual-triage.md and the
// merge contract mirrors cw-orchestrate's merge-safety.md. Those files are
// the human-readable source of truth; the string constants below are what runs.

export const meta = {
  name: 'cw-sweep',
  description:
    'Clear the backlog of open review-residual issues: re-judge each finding against the shipped code, close what is resolved or moot, auto-apply high-confidence fixes, and escalate only genuine judgment calls.',
  whenToUse:
    'To triage the standing backlog of cw-orchestrate review-residual issues (or a specific subset), out of band from an umbrella run.',
  phases: [
    { title: 'Discover', detail: 'list open review-residual issues and map each to its sub-issue' },
    { title: 'Triage', detail: 'per residual: classify vs shipped code; close resolved/moot' },
    { title: 'Autofix', detail: 'high-confidence FIX_NOW findings -> PR -> serial merge (opt-in)' },
  ],
};

// ---------------------------------------------------------------------------
// Structured-output schemas
// ---------------------------------------------------------------------------

const DISCOVER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['residuals'],
  properties: {
    residuals: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['residual_issue', 'residual_url', 'sub_issue'],
        properties: {
          residual_issue: { type: 'integer' },
          residual_url: { type: 'string', minLength: 1 },
          sub_issue: { type: 'integer' }, // the resolved UNDERLYING feature issue
          relates_to: { type: ['integer', 'null'] }, // the immediate "Relates to #n" target
          chain: { type: 'array', items: { type: 'integer' } }, // immediate -> ... -> feature
          umbrella: { type: ['integer', 'null'] },
        },
      },
    },
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
        },
      },
    },
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

// ---------------------------------------------------------------------------
// Pure triage-decision logic — MIRROR of triage.mjs (kept in sync; tested there).
// A Workflow script cannot import sibling modules at runtime, so the canonical
// implementation is duplicated here verbatim. Do not edit one without the other.
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

function deferredResiduals(results) {
  return (results || [])
    .filter(Boolean)
    .filter((r) => r.shipped === false)
    .map((r) => r.residual_issue)
    .sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// Role prompt builders (mirror references/residual-triage.md & merge-safety.md)
// ---------------------------------------------------------------------------

const discoverPrompt = (a) => `You are enumerating open "review-residual" issues in repo ${a.repo} so they can be triaged, using gh via Bash. These issues were filed by cw-orchestrate's plan-review stage; each one tracks a feature sub-issue and links it with a "Relates to #<n>" line in its body.

Scope:
${
  Array.isArray(a.only) && a.only.length
    ? `Only these residual issue numbers: ${a.only.join(', ')}. Verify each actually carries the "review-residual" label; drop any that do not.`
    : a.umbrella
      ? `All OPEN issues labeled "review-residual" whose body references umbrella #${a.umbrella} (an "Umbrella #${a.umbrella}" line).`
      : `All OPEN issues labeled "review-residual".`
}

Steps:
1. List candidates: \`gh issue list --repo ${a.repo} --state open --label review-residual --limit 200 --json number,title,body\`${Array.isArray(a.only) && a.only.length ? ` (or fetch the named numbers directly with \`gh issue view\` and confirm the label).` : '.'}
2. For each in-scope residual, resolve the underlying FEATURE issue it ultimately concerns. Residual titles are always "review-residual: plan findings for #<n>", and the body carries a matching "Relates to #<n>" line.
   a. The immediate target is that #<n>.
   b. If the immediate target is ITSELF a review-residual issue (its title begins "review-residual:" or it carries the review-residual label), this is a NESTED adoption: a later cw-orchestrate run adopted an older residual as a sub-issue. Read that issue's title "plan findings for #<m>" and follow to #<m>. Repeat until you reach an issue that is NOT a review-residual issue — that terminal issue is the underlying feature. Use \`gh issue view <n> --repo ${a.repo} --json title,labels\` to test each hop.
   c. Record the full chain of issue numbers walked, the immediate target as relates_to, and the terminal feature as sub_issue. (If the immediate target is already a feature, chain is just [feature] and relates_to == sub_issue.)
   Guard against loops: stop after a reasonable number of hops and, if you cannot reach a non-residual feature, set sub_issue to the last issue in the chain.
3. Parse the umbrella number (the "Umbrella #<n>" line, or null if absent). Build residual_url as https://github.com/${a.repo}/issues/<number>.

Return ONLY in-scope residuals. Return structured output: { residuals: [{ residual_issue, residual_url, sub_issue, relates_to, chain, umbrella }] }.`;

const triagePrompt = (a, subIssue, residualUrl, chain) => `You are triaging a "review-residual" issue against the SHIPPED code on ${a.defaultBranch}, headless, with no human. These residuals were filed against an implementation PLAN; re-judge each finding against what actually landed, then act on the cheap/clear ones and leave only genuine judgment calls for a human.

Repo ${a.repo}, default branch ${a.defaultBranch}.
Residual issue: ${residualUrl}
Underlying feature: #${subIssue}${Array.isArray(chain) && chain.length > 1 ? `\nResolved through a nested residual chain: ${chain.map((n) => '#' + n).join(' -> ')} — the residual tracks an earlier residual that ultimately concerns the feature. Triage the findings against the feature's code, using the intermediate residuals/PRs only as context.` : ''}

Steps:
1. Read the residual body (\`gh issue view ${residualUrl} --json title,body\`) and extract its findings.
2. Determine whether the feature #${subIssue} has SHIPPED — i.e. its code is on ${a.defaultBranch} now. Try these in order and stop at the first that resolves it:
   a. \`gh issue view ${subIssue} --repo ${a.repo} --json state,stateReason,closedByPullRequestsReferences\`. A MERGED closing PR => shipped (note the PR for context).
   b. No closing-PR link does NOT mean unshipped — issues closed without a "Closes #" keyword have none. Search directly: \`gh pr list --repo ${a.repo} --state merged --search "${subIssue}"\` and \`git fetch origin ${a.defaultBranch} -q && git log --oneline --grep "#${subIssue}" origin/${a.defaultBranch}\`. A merged PR or merge commit referencing it => shipped.
   c. If still unresolved but the issue is CLOSED-as-completed AND the files/symbols the findings name are present at ${a.defaultBranch} HEAD => shipped.
   Conclude NOT shipped ONLY when the feature is open/halted AND no merged PR or merge commit references it AND its code is absent at HEAD (e.g. a P0-halted feature). Then set shipped:false, mark every finding "DECISION" with rationale "feature not yet shipped; cannot triage against code", do NOT close, and return. A future run triages it once the feature lands.
3. If shipped, judge each finding against the GROUND TRUTH = the current files at ${a.defaultBranch} HEAD (read them directly), using any merged PR diffs you found as supporting context. The current code is authoritative even when you cannot pin the exact PR. For EACH finding:
   - RESOLVED — the code at HEAD already does the right thing. Cite the file/line that proves it.
   - FIX_NOW  — a real, small, unambiguous fix. Set confidence "high" only if you are sure the fix is correct, safe, and in-scope (it will be applied and merged with NO human review). Any ambiguity about correctness, scope, or approach => "low".
   - DECISION — needs a human judgment call (a real trade-off, a product/behavior choice, or a fix whose correct form is unclear). Reserve it for genuine choices.
   - MOOT     — the finding was wrong, or the implementation diverged so it no longer applies.
4. Post ONE triage comment on the residual summarizing each finding's verdict + one-line rationale (\`gh issue comment ${residualUrl} --body-file <(...)\`).
5. CLOSE the residual ONLY if every finding is RESOLVED or MOOT (no action remains): \`gh issue close ${residualUrl} --comment "Triaged: all findings resolved in shipped code or moot. <one line>"\` and set closed:true. Otherwise leave it open (high-confidence FIX_NOW findings are auto-fixed in a later sweep; DECISION / low-confidence findings await a human) and set closed:false.

Be conservative about closing and about high-confidence: closing a real issue or auto-merging a wrong fix is worse than leaving a residual open for a human.

Return structured output: { residual_issue, sub_issue, shipped, closed, findings: [{title, severity, verdict, confidence, rationale, fix_hint}] }. Set sub_issue to the underlying feature #${subIssue}.`;

const autofixPrompt = (a, tr) => `You are implementing ONLY a set of small, high-confidence cleanup fixes for review-residual #${tr.residual_issue} (sub-issue #${tr.sub_issue}) in an isolated git worktree, headless, with no human. Do NOT merge; the orchestrator merges serially after you return.

Repo ${a.repo}, base ${a.defaultBranch}. Implement EXACTLY these triaged fixes and nothing more:
\`\`\`json
${JSON.stringify(highConfidenceFixes(tr).map((f) => ({ title: f.title, fix_hint: f.fix_hint, rationale: f.rationale })), null, 2)}
\`\`\`

FRESHNESS PRE-CHECK — do this FIRST, before branching or writing any code. The triage that produced these fixes is a snapshot and may be stale: between triage and now, a parallel PR or another session can close the residual or land an equivalent fix on \`${a.defaultBranch}\`. Building a PR for already-done work burns a PR + CI cycle for nothing — this check prevents exactly that.
- a. Confirm the residual is still OPEN: \`gh issue view ${tr.residual_issue} --repo ${a.repo} --json state,closedByPullRequestsReferences\`. If it is CLOSED, STOP: do not branch or open a PR; report ready_to_merge:false, cause "residual #${tr.residual_issue} already closed since triage".
- b. \`git fetch origin ${a.defaultBranch} -q\`, then for each listed fix read the file(s) it would touch at fresh \`origin/${a.defaultBranch}\` HEAD and DROP any whose change is already present (an equivalent guard/test/code merged since triage — search for the symbol/test name, do not assume). If EVERY listed fix is already on \`${a.defaultBranch}\`, STOP: report ready_to_merge:false, cause "fixes already landed on ${a.defaultBranch} (equivalent work merged since triage)". Otherwise proceed with ONLY the fixes that are genuinely still needed.

Steps:
1. Branch off fresh \`${a.defaultBranch}\` in your worktree.
2. Implement ONLY the listed fixes. Stay strictly in scope. If a "fix" turns out to be larger, ambiguous, or riskier than its description, SKIP it and record that in \`cause\` rather than expanding scope or guessing.
3. Follow repo conventions (AGENTS.md/CLAUDE.md): regenerate generated files rather than hand-editing; add or extend tests for changed behavior; keep coverage above the repo bar. Run the build + test suite; tests must pass before you open a PR.
4. Open a PR. Conventional-commit title (\`fix\`/\`test\`/\`docs\`/\`chore\` scope as fits). Body: Summary + Test plan. ${closeDisposition(tr) === 'close-via-autofix' ? `Include \`Closes #${tr.residual_issue}\` on its own line — these fixes resolve every remaining actionable finding.` : `Include \`Relates to #${tr.residual_issue}\` on its own line. Do NOT close it: unresolved DECISION/low-confidence findings remain for a human.`} Push the branch.
5. Run a code-review pass on your own diff. A P0 is a correctness/security/data-loss/scope finding that must not merge. Fix and re-review if you can; if a P0 cannot be safely auto-fixed here, leave the PR open and report p0:true.
6. Report issue=${tr.residual_issue}, the PR number/URL, branch, files changed, and your verdict.

If you cannot reach green build + passing tests + clean review, report ready_to_merge:false with the cause rather than papering over it.

Return structured output: { issue, ready_to_merge, p0, pr_number, pr_url, branch, changed_paths, cause }.`;

const mergePrompt = (a, built) => `You are performing a SERIALIZED merge of one already-built PR to \`${a.defaultBranch}\` in repo ${a.repo}, headless, with no human. Only one merge runs at a time; you are it right now.

PR #${built.pr_number} (${built.pr_url}), branch \`${built.branch}\`, residual #${built.issue}.

Steps:
1. \`git fetch origin ${a.defaultBranch} ${built.branch}\`.
2. PRE-MERGE CONFLICT CHECK against FRESH ${a.defaultBranch}: \`git merge-tree --write-tree --name-only origin/${a.defaultBranch} origin/${built.branch}\`. If it reports a conflict, do NOT merge: try ONE clean rebase of the branch onto fresh ${a.defaultBranch} and push with --force-with-lease; if it still conflicts or needs human judgment, report merged:false, cause "pre-merge conflict against ${a.defaultBranch}".
3. If clean: \`gh pr merge ${built.pr_number} --repo ${a.repo} --squash --admin --delete-branch\`.
4. Verify: PR state is MERGED; branch is gone (\`git ls-remote --heads origin ${built.branch}\` empty — if not, \`git push origin --delete ${built.branch}\`).
5. Post-merge CI: check ${a.defaultBranch} CI for the merge commit is green.

Green = PR MERGED AND post-merge ${a.defaultBranch} CI green. Anything else is not green; report the cause. Never force-resolve a conflict.

Return structured output: { issue, merged, pr_state, branch_gone, ci_green, cause }.`;

// ---------------------------------------------------------------------------
// Orchestration body
// ---------------------------------------------------------------------------

let cfg = args;
if (typeof cfg === 'string') {
  try {
    cfg = JSON.parse(cfg);
  } catch (e) {
    throw new Error(`cw-sweep: args is a string but not valid JSON: ${e.message}`);
  }
}
if (!cfg || !cfg.repo) {
  throw new Error('cw-sweep: args must include { repo }');
}
cfg.defaultBranch = cfg.defaultBranch || 'main';
const runAutofix = cfg.autofix !== false; // default on

// --- Discover --------------------------------------------------------------
phase('Discover');
const discovered = await agent(discoverPrompt(cfg), {
  label: 'discover',
  phase: 'Discover',
  schema: DISCOVER_SCHEMA,
});
const residuals = (discovered && discovered.residuals) || [];
log(`Discovered ${residuals.length} open review-residual issue(s).`);
if (residuals.length === 0) {
  return { repo: cfg.repo, triaged: [], autofixed: [], escalations: [], deferred_residuals: [] };
}

// --- Triage (classify + close), one subagent per residual, in parallel -----
phase('Triage');
const triageResults = (
  await parallel(
    residuals.map((r) => () =>
      agent(triagePrompt(cfg, r.sub_issue, r.residual_url, r.chain || []), {
        label: `triage:${r.residual_issue}`,
        phase: 'Triage',
        schema: TRIAGE_SCHEMA,
      }),
    ),
  )
).filter(Boolean);
const closedCount = triageResults.filter((t) => t.closed).length;
log(`Triaged ${triageResults.length}; closed ${closedCount}.`);

// --- Autofix sweep (opt-in), sequential over a quiescent default branch ----
const autofixed = [];
if (runAutofix) {
  phase('Autofix');
  const queue = autofixCandidates(triageResults);
  log(`Autofix queue: ${queue.length} residual(s) with high-confidence fixes.`);
  for (const residualIssue of queue) {
    const tr = triageResults.find((t) => t.residual_issue === residualIssue);
    const built = await agent(autofixPrompt(cfg, tr), {
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
      });
      continue;
    }
    const mResult = await agent(mergePrompt(cfg, built), {
      label: `autofix-merge:${residualIssue}`,
      phase: 'Autofix',
      schema: MERGE_SCHEMA,
    });
    const merged = !!(mResult.merged && mResult.ci_green !== false);
    autofixed.push({
      residual_issue: residualIssue,
      pr: built.pr_url || null,
      merged,
      cause: merged ? null : mResult.cause || 'autofix merge not green',
    });
    log(`Autofix #${residualIssue}: ${merged ? 'merged' : 'stalled — ' + (mResult.cause || 'not green')}`);
  }
}

// --- Report ----------------------------------------------------------------
const report = {
  repo: cfg.repo,
  triaged: triageResults.map((t) => ({
    residual_issue: t.residual_issue,
    sub_issue: t.sub_issue,
    shipped: t.shipped !== false,
    closed: !!t.closed,
    disposition: closeDisposition(t),
  })),
  autofixed,
  escalations: escalations(triageResults),
  deferred_residuals: deferredResiduals(triageResults),
};
log(
  `Done. triaged=${report.triaged.length} closed=${report.triaged.filter((t) => t.closed).length} ` +
    `autofixed=${report.autofixed.filter((a) => a.merged).length}/${report.autofixed.length} ` +
    `escalations=${report.escalations.length} deferred=${report.deferred_residuals.length}`,
);
return report;
