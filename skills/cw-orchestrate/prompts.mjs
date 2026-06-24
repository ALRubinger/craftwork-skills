// Canonical, unit-tested role-prompt builders for cw-orchestrate.
//
// `workflow.js` inlines BYTE-FOR-BYTE mirrors of these builders because a
// Claude Code Workflow script (a) auto-runs its body on evaluation and (b) has
// no filesystem/module access at runtime, so it can neither be imported by a
// Node test nor import this module. This file is the tested source of truth;
// keep the mirror in workflow.js in sync. `tests/mirror.test.mjs` drift-guards
// the two copies (it renders both for a fixed manifest and asserts equality).
//
// Determinism: these are pure string builders — no Date.now(), no Math.random(),
// no argless `new Date()` (all forbidden in Workflow scripts).
//
// Every run targets `defaultBranch`: plan/work/autofix subagents fetch and branch
// off it, the squash-merge lands on it, and merge-tree checks the diff against it.

// `autofixPrompt` renders the triage's high-confidence fixes and chooses its
// close-vs-relate disposition; both come from the canonical triage logic.
import { highConfidenceFixes, closeDisposition } from './triage.mjs';

export const planPrompt = (m, issue, briefText) => {
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

export const workPrompt = (m, node) => {
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

export const mergePrompt = (m, built) => {
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

export const triagePrompt = (m, subIssue, residualUrl, prHint) => {
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

// decisionFindings + parkResidualPrompt drive the in-run PARK step: the headless
// analog of the autofix sweep. After triage, each parkCandidates() residual gets
// a "## Decision needed" block written into its body and the
// cw-review-residual:needs-input label, so a standalone /cw-resolve (which queries
// --label cw-review-residual:needs-input) can discover and drain it. This mirrors
// cw-sweep's Park phase; the same decision_question / recommended_answer /
// alt_options fields authored at triage feed the parked block verbatim.
//
// Not byte-mirrored as `function NAME` blocks (they are arrow consts holding
// template literals); mirror.test.mjs renders them and asserts equality instead.

export const decisionFindings = (tr) =>
  ((tr && tr.findings) || []).filter(
    (f) => f.verdict === 'DECISION' || (f.verdict === 'FIX_NOW' && f.confidence !== 'high'),
  );

export const parkResidualPrompt = (m, tr, residualUrl) => `You are PARKING one cw-review-residual issue for the operator's input, using gh via Bash. Repo ${m.repo}. Residual: ${residualUrl} (#${tr.residual_issue}, feature #${tr.sub_issue}). Its findings against the shipped code include genuine judgment calls only the operator should make.

Steps:
1. Fetch the current body: \`gh issue view ${tr.residual_issue} --repo ${m.repo} --json body -q .body > body.md\`.
2. Write the decisions into body.md as a "## Decision needed" block — one numbered entry per decision below, each showing the question, your recommended answer, and the alternatives. Each entry MUST carry an "**Answer:** " line (left blank for the operator to fill) so /cw-resolve can parse and write the answer back. If a "## Decision needed" block already exists (a prior park), REPLACE it in place rather than appending a second one. The decisions:
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
   End the block with: "_To proceed: answer each decision inline above, then add the \\\`cw-review-residual:go\\\` label (or run /cw-resolve). The next cw-sweep run applies your answers._"
   Use \`gh issue edit ${tr.residual_issue} --repo ${m.repo} --body-file body.md\` (never hand-escape backticks or checklists).
3. Flip labels to the parked state: \`gh issue edit ${tr.residual_issue} --repo ${m.repo} --add-label cw-review-residual:needs-input --remove-label cw-review-residual:go\` (create cw-review-residual:needs-input first if missing: color D93F0B). Do NOT add cw-review-residual:go — that is the operator's action.

Return structured output: { issue: ${tr.residual_issue}, parked: true }.`;

export const autofixPrompt = (m, tr) => {
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
2. Implement ONLY the listed fixes. Stay strictly in scope. If a "fix" turns out to be larger, ambiguous, or riskier than its description, SKIP it and record that in \`cause\` rather than expanding scope or guessing — a skipped fix is fine; an over-reaching one is not.
3. Follow repo conventions (AGENTS.md/CLAUDE.md): regenerate generated files rather than hand-editing; add or extend tests for changed behavior; keep coverage above the repo bar. Run the build + test suite; tests must pass before you open a PR.
4. Open a PR. Conventional-commit title (\`fix\`/\`test\`/\`docs\`/\`chore\` scope as fits). Body: Summary + Test plan. ${closeDisposition(tr) === 'close-via-autofix' ? `Include \`Closes #${tr.residual_issue}\` on its own line — these fixes resolve every remaining actionable finding.` : `Include \`Relates to #${tr.residual_issue}\` on its own line. Do NOT close it: unresolved DECISION/low-confidence findings remain for a human.`} Push the branch.
5. Run a code-review pass on your own diff. A P0 is a correctness/security/data-loss/scope finding that must not merge. Fix and re-review if you can; if a P0 cannot be safely auto-fixed here, leave the PR open and report p0:true.
6. Report issue=${tr.residual_issue}, the PR number/URL, branch, files changed, and your verdict.

If you cannot reach green build + passing tests + clean review, report ready_to_merge:false with the cause rather than papering over it.

Return structured output: { issue, ready_to_merge, p0, pr_number, pr_url, branch, changed_paths, cause }.`;
};
