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
// Base vs. target (see references/manifest-schema.md):
//   - `defaultBranch` is the FRESHNESS BASE: where work branches off / fetches
//     for fresh code, regardless of where the PR ultimately lands.
//   - `targetBranch` (optional; defaults to `defaultBranch`) is the MERGE TARGET:
//     the branch the squash-merge lands on and the branch merge-tree checks the
//     diff against. When absent or equal to `defaultBranch`, every rendered
//     string is byte-identical to the single-branch behavior.

// Resolve the merge target. `??` (not `||`) so an intentional empty string is
// NOT silently replaced; only an absent (undefined/null) targetBranch falls
// back to the freshness base.
export const mergeTarget = (m) => m.targetBranch ?? m.defaultBranch;

export const workPrompt = (m, node) => `You are implementing one GitHub issue in an isolated git worktree, in a fresh context, with no human available. Take it from plan to an open, review-clean PR — do NOT merge; the orchestrator merges serially after you return.

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

export const mergePrompt = (m, built) => {
  const target = mergeTarget(m);
  // Fetch the freshness base AND the merge target (deduped so the single-branch
  // case yields exactly `git fetch origin main <branch>` — byte-identical).
  const fetchRefs = [...new Set([m.defaultBranch, target, built.branch])].join(' ');
  return `You are performing a SERIALIZED merge of one already-built PR to \`${target}\` in repo ${m.repo}, headless, with no human. Only one merge runs at a time; you are it right now.

PR #${built.pr_number} (${built.pr_url}), branch \`${built.branch}\`, issue #${built.issue}.

Steps (see references/merge-safety.md):
1. \`git fetch origin ${fetchRefs}\`.
2. PRE-MERGE CONFLICT CHECK against FRESH ${target}: run \`git merge-tree --write-tree --name-only origin/${target} origin/${built.branch}\`. If it reports a conflict, do NOT merge: try ONE clean rebase of the branch onto fresh ${target} and push with --force-with-lease; if it still conflicts or needs human judgment, report merged:false, cause "pre-merge conflict against ${target}".
3. PRE-MERGE CI GATE — wait for green, then merge. NEVER merge over a pending or failing blocking check; \`--admin\` bypasses required-review, NOT in-progress or failing validation.
   a. Block until every check concludes: \`gh pr checks ${built.pr_number} --repo ${m.repo} --watch --interval 30\` (no \`queued\`/\`in_progress\` may remain). Then read final conclusions: \`gh pr checks ${built.pr_number} --repo ${m.repo}\`.
   b. BLOCKING checks — build, unit/integration tests, lint, vet, type/Svelte check, smoke builds, security scans — MUST every one conclude \`success\`. If ANY concluded \`failure\`/\`timed_out\`/\`startup_failure\`/\`action_required\`, do NOT merge: report \`merged:false\`, put their names in \`ci.failing_checks\`, set cause "pre-merge CI failed: <checks>". Do NOT fix it here (that is the work step's job) — the node stalls for the operator with the failing check named.
   c. ADVISORY checks — coverage thresholds (\`codecov/patch\`, \`codecov/project\`) and preview/deploy checks (e.g. a Railway \`… - docs\` deployment reporting \`cancelled\`) — are soft gates per repo policy. A non-\`success\` advisory check does NOT block; record its name in \`ci.advisory_nonblocking\` and proceed. When unsure whether a check is blocking, treat it as BLOCKING; consult the repo's CLAUDE.md / AGENTS.md if it names required checks.
   d. If checks never conclude within ~30 minutes, report \`merged:false\`, cause "pre-merge CI did not conclude (timeout)".
4. Only when every blocking check is green: \`gh pr merge ${built.pr_number} --repo ${m.repo} --squash --admin --delete-branch\`.
5. Verify: PR state is MERGED (\`gh pr view ${built.pr_number} --repo ${m.repo} --json state\`); branch is gone (\`git ls-remote --heads origin ${built.branch}\` empty — if not, \`git push origin --delete ${built.branch}\`). Report \`merged: true\`.
6. POST-MERGE sanity (regression detector only — the landing already passed CI in step 3, so this rarely fires). Inspect the merge commit's checks (\`gh pr checks ${built.pr_number} --repo ${m.repo}\` / \`gh run list\`):
   - A run \`cancelled\` by GitHub Actions \`concurrency: cancel-in-progress\` (a later commit landed on \`${target}\` — the next serialized node or an unrelated bot PR such as Renovate) is NOT a failure. Set \`ci.cancelled: true\`; confirm on the \`${target}\` TIP and only record a genuinely-failed check in \`failing_checks\`.
   - Only a real \`failure\` conclusion on the merge commit (not advisory, not cancelled) goes in \`ci.failing_checks\`; it is surfaced as a post-merge regression warning on the merged node, NOT a stall (the PR has merged).

Never force-resolve a conflict. Never merge over a pending or failing blocking check.

Return structured output: { issue, merged, pr_state, branch_gone, ci: { failing_checks, advisory_nonblocking, cancelled, pending }, cause }.`;
};

export const triagePrompt = (m, subIssue, residualUrl, prHint) => {
  const target = mergeTarget(m);
  return `You are triaging a "cw-review-residual" issue against the SHIPPED code, headless, with no human. These residuals were filed against an implementation PLAN; your job is to re-judge each finding against what actually merged, then act on the cheap/clear ones and leave only genuine judgment calls for a human.

Repo ${m.repo}, default branch ${target}.
Residual issue: ${residualUrl}
Tracks sub-issue: #${subIssue}${prHint ? `\nThe sub-issue merged via: ${prHint}` : ''}

Steps:
1. Read the residual issue body (\`gh issue view ${residualUrl} --json title,body\`) and extract its findings.
2. Establish whether the sub-issue #${subIssue} has SHIPPED: confirm its closing PR is MERGED${prHint ? ` (${prHint})` : ` (\`gh issue view ${subIssue} --repo ${m.repo} --json state,closedByPullRequestsReferences\`, then verify that PR is MERGED)`}. If it has NOT shipped (open/halted, no merged PR), set shipped:false, mark every finding verdict "DECISION" with rationale "sub-issue not yet shipped; cannot triage against code", do NOT close the residual, and return. A future run triages it once the feature lands.
3. If shipped, read the merged diff (\`gh pr diff <pr> --repo ${m.repo}\`) and the current files on ${target}. For EACH finding, classify against the shipped code:
   - RESOLVED — the merged code already does the right thing. Cite the file/line that proves it.
   - FIX_NOW  — a real, small, unambiguous fix. Set confidence "high" only if you are sure the fix is correct, safe, and in-scope (it will be applied and merged with NO human review). If there is any ambiguity about correctness, scope, or approach, set confidence "low".
   - DECISION — needs a human judgment call (a real trade-off, a product/behavior choice, or a fix whose correct form is unclear). Never use this as a dumping ground; reserve it for genuine choices.
   - MOOT     — the finding was wrong, or the implementation diverged so it no longer applies.
4. Post ONE triage comment on the residual summarizing each finding's verdict + one-line rationale (\`gh issue comment ${residualUrl} --body-file <(...)\`).
5. CLOSE the residual ONLY if every finding is RESOLVED or MOOT (no action remains): \`gh issue close ${residualUrl} --comment "Triaged: all findings resolved in shipped code or moot. <one line>"\` and set closed:true. Otherwise leave it open (high-confidence FIX_NOW findings are auto-fixed in a later sweep; DECISION / low-confidence findings await a human) and set closed:false.

Be conservative about closing and about high-confidence: closing a real issue or auto-merging a wrong fix is worse than leaving a residual open for a human.

Return structured output: { residual_issue, sub_issue, shipped, closed, findings: [{title, severity, verdict, confidence, rationale, fix_hint}] }.`;
};
