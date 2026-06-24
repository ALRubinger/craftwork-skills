// cw-sweep Workflow: discover -> triage (classify + close) -> autofix.
//
// Launched by SKILL.md with `args` = { repo, defaultBranch, umbrella?, only?,
// autofix }. Runs headless in the background. Clears the backlog of open
// `cw-review-residual` issues that cw-orchestrate files: re-judges each
// finding against the SHIPPED code, closes what is resolved/moot, optionally
// auto-applies high-confidence fixes, and surfaces only genuine judgment calls.
//
// Integration-branch aware, PER RESIDUAL. A single sweep mixes residuals from
// different umbrellas, so each residual's ground-truth / merge target is derived
// independently from its umbrella's cw-target:<slug> label (cw-orchestrate's
// target.mjs deriveTarget rules, applied inline by the Discover subagent against
// gh-fetched labels — no JS import). One cw-target:* label => integration/<slug>;
// zero => defaultBranch. That target_branch then threads through triage (judge
// against integration/<slug> HEAD; a missing integration branch defers), autofix
// (fork + PR base), and merge. A soft target_mismatches[] report section flags
// any autofix PR whose actual base disagreed with the derived target.
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
    'Clear the backlog of open cw-review-residual issues: re-judge each finding against the shipped code, close what is resolved or moot, auto-apply high-confidence fixes, and escalate only genuine judgment calls.',
  whenToUse:
    'To triage the standing backlog of cw-orchestrate cw-review-residual issues (or a specific subset), out of band from an umbrella run.',
  phases: [
    { title: 'Discover', detail: 'list open cw-review-residual issues and map each to its sub-issue' },
    { title: 'Triage', detail: 'per residual: classify vs shipped code; close resolved/moot' },
    { title: 'Autofix', detail: 'high-confidence FIX_NOW findings -> PR -> serial merge (opt-in)' },
    { title: 'Park', detail: 'write a "## Decision needed" block + needs-input label for residuals with judgment calls' },
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
        required: ['residual_issue', 'residual_url', 'sub_issue', 'human_state', 'target_branch'],
        properties: {
          residual_issue: { type: 'integer' },
          residual_url: { type: 'string', minLength: 1 },
          sub_issue: { type: 'integer' }, // the resolved UNDERLYING feature issue
          relates_to: { type: ['integer', 'null'] }, // the immediate "Relates to #n" target
          chain: { type: 'array', items: { type: 'integer' } }, // immediate -> ... -> feature
          umbrella: { type: ['integer', 'null'] },
          // The per-residual merge/ground-truth target, derived from the umbrella's
          // cw-target:<slug> label by deriveTarget's rules (applied inline in the
          // Discover prompt against gh-fetched labels — no JS import). One
          // cw-target:* label => integration/<slug>; zero => defaultBranch; >1 or an
          // empty slug => the residual is left at defaultBranch and flagged in prose.
          target_branch: { type: 'string', minLength: 1 },
          // Where this residual sits in the park/resolve/go loop, from its labels:
          //   fresh       — no human-loop label; triage normally, park if decisions remain.
          //   needs-input — parked, awaiting the operator; SKIP (do not re-triage/clobber).
          //   go          — operator answered inline; triage in CONSUME mode (read answers).
          human_state: { type: 'string', enum: ['fresh', 'needs-input', 'go'] },
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
    // The base branch the autofix PR was actually opened against. Compared with
    // the residual's derived target_branch to populate report.target_mismatches[]
    // (a SOFT diagnostic — see targetMismatches()). Null when no PR was opened.
    base_branch: { type: ['string', 'null'] },
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

function targetMismatches(records) {
  return (records || [])
    .filter(Boolean)
    .filter(
      (r) =>
        typeof r.target_branch === 'string' &&
        r.target_branch !== '' &&
        typeof r.actual_base === 'string' &&
        r.actual_base !== '' &&
        r.target_branch !== r.actual_base,
    )
    .map((r) => ({
      residual_issue: r.residual_issue,
      sub_issue: r.sub_issue ?? null,
      target_branch: r.target_branch,
      actual_base: r.actual_base,
    }))
    .sort((a, b) => a.residual_issue - b.residual_issue);
}

// ---------------------------------------------------------------------------
// Role prompt builders (mirror references/residual-triage.md & merge-safety.md)
// ---------------------------------------------------------------------------

const discoverPrompt = (a) => `You are enumerating open "cw-review-residual" issues in repo ${a.repo} so they can be triaged, using gh via Bash. These issues were filed by cw-orchestrate's plan-review stage; each one tracks a feature sub-issue and links it with a "Relates to #<n>" line in its body.

Scope:
${
  Array.isArray(a.only) && a.only.length
    ? `Only these residual issue numbers: ${a.only.join(', ')}. Verify each actually carries the "cw-review-residual" label; drop any that do not.`
    : a.umbrella
      ? `All OPEN issues labeled "cw-review-residual" whose body references umbrella #${a.umbrella} (an "Umbrella #${a.umbrella}" line).`
      : `All OPEN issues labeled "cw-review-residual".`
}

Steps:
1. List candidates: \`gh issue list --repo ${a.repo} --state open --label cw-review-residual --limit 200 --json number,title,body,labels\`${Array.isArray(a.only) && a.only.length ? ` (or fetch the named numbers directly with \`gh issue view\` and confirm the label).` : '.'}
2. For each in-scope residual, resolve the underlying FEATURE issue it ultimately concerns. Residual titles are always "cw-review-residual: plan findings for #<n>", and the body carries a matching "Relates to #<n>" line.
   a. The immediate target is that #<n>.
   b. If the immediate target is ITSELF a cw-review-residual issue (its title begins "cw-review-residual:" or it carries the cw-review-residual label), this is a NESTED adoption: a later cw-orchestrate run adopted an older residual as a sub-issue. Read that issue's title "plan findings for #<m>" and follow to #<m>. Repeat until you reach an issue that is NOT a cw-review-residual issue — that terminal issue is the underlying feature. Use \`gh issue view <n> --repo ${a.repo} --json title,labels\` to test each hop.
   c. Record the full chain of issue numbers walked, the immediate target as relates_to, and the terminal feature as sub_issue. (If the immediate target is already a feature, chain is just [feature] and relates_to == sub_issue.)
   Guard against loops: stop after a reasonable number of hops and, if you cannot reach a non-residual feature, set sub_issue to the last issue in the chain.
3. Parse the umbrella number (the "Umbrella #<n>" line, or null if absent). Build residual_url as https://github.com/${a.repo}/issues/<number>.
3a. Derive each residual's per-residual TARGET BRANCH from its umbrella's labels — the branch its findings are judged against and where any autofix PR must land. cw-sweep mixes residuals from different umbrellas in one run, so this is resolved PER RESIDUAL, not once for the run. The umbrella's \`cw-target:<slug>\` label is the SINGLE SOURCE OF TRUTH for the merge target (cw-orchestrate's target.mjs deriveTarget rules), applied here inline against gh-fetched labels — do NOT import any JS:
   - If umbrella is null, set target_branch = "${a.defaultBranch}" (no umbrella => default branch).
   - Else fetch the umbrella's labels: \`gh issue view <umbrella> --repo ${a.repo} --json labels --jq '.labels[].name'\` and find the labels that start with \`cw-target:\`.
     - EXACTLY ONE \`cw-target:<slug>\` label => target_branch = "integration/<slug>" (the slug is the label suffix verbatim, already git-ref-safe; do not normalize it).
     - ZERO \`cw-target:*\` labels => target_branch = "${a.defaultBranch}" (behavior unchanged).
     - MORE THAN ONE \`cw-target:*\` label, OR a label whose slug is empty/whitespace-only (e.g. bare \`cw-target:\`) => this is a malformed umbrella. Do NOT guess a target: set target_branch = "${a.defaultBranch}" and note the malformed umbrella in your triage/discovery comment so the operator fixes the label. (deriveTarget hard-errors on these; in a per-residual sweep we degrade to the default branch rather than abort every other residual.)
   target_branch is always a non-empty branch name — never null. When it is an \`integration/<slug>\` branch that does not yet exist on the remote, that is fine: the triage step treats a missing integration branch as "feature not yet shipped" and defers.
4. Classify each residual's human_state from its labels (the park/resolve/go loop):
   - "go"          if it carries the "cw-review-residual:go" label (the operator answered the parked decisions inline; it will be triaged in consume mode).
   - "needs-input" else if it carries "cw-review-residual:needs-input" (parked, still awaiting the operator; it will be skipped this run, not re-triaged).
   - "fresh"       otherwise.

Return ONLY in-scope residuals. Return structured output: { residuals: [{ residual_issue, residual_url, sub_issue, relates_to, chain, umbrella, human_state, target_branch }] }.`;

const triagePrompt = (a, subIssue, residualUrl, chain, mode, target) => `You are triaging a "cw-review-residual" issue against the SHIPPED code on ${target}, headless, with no human. These residuals were filed against an implementation PLAN; re-judge each finding against what actually landed, then act on the cheap/clear ones and leave only genuine judgment calls for a human.

Repo ${a.repo}. GROUND-TRUTH BRANCH for this residual: ${target}${target === a.defaultBranch ? ` (the repo's default branch).` : ` — this residual's umbrella carries a cw-target:<slug> label, so its feature is being integrated on the integration branch \`${target}\`, NOT yet on ${a.defaultBranch}. Judge "shipped?" and every finding against \`${target}\` HEAD. If \`${target}\` does not exist on the remote yet, the feature has not shipped there: set shipped:false and DEFER (exactly like an unshipped default-branch feature, step 2 below).`}
Residual issue: ${residualUrl}
Underlying feature: #${subIssue}${Array.isArray(chain) && chain.length > 1 ? `\nResolved through a nested residual chain: ${chain.map((n) => '#' + n).join(' -> ')} — the residual tracks an earlier residual that ultimately concerns the feature. Triage the findings against the feature's code, using the intermediate residuals/PRs only as context.` : ''}
${
  mode === 'consume'
    ? `\nCONSUME MODE: this residual was parked for a decision and the operator has now ANSWERED (label cw-review-residual:go). Its body has a "## Decision needed" block whose entries each carry an "**Answer:** <decision>" line. Treat each answer as the SETTLED decision and re-classify the finding it answers:
- answer accepts current behavior / "leave as-is" / "no change" => RESOLVED (or MOOT if the finding no longer applies).
- answer specifies a change ("do X", "use Y") => FIX_NOW, confidence "high" (the operator authorized this exact change), fix_hint = the operator's specified change.
- answer is genuinely ambiguous or raises a NEW fork => keep DECISION (it will re-park) and emit fresh decision_question/recommended_answer/alt_options.
Findings with NO operator answer are re-judged normally (below). Leave the cw-review-residual:go label in place — closing the residual (now or via the autofix PR) clears it, a re-park flips it to needs-input, and if it stays open for autofix a re-run re-consumes the same answers idempotently. Do not remove it by hand.\n`
    : ''
}
Steps:
1. Read the residual body (\`gh issue view ${residualUrl} --json title,body\`) and extract its findings.
2. Determine whether the feature #${subIssue} has SHIPPED — i.e. its code is on the ground-truth branch \`${target}\` now. Try these in order and stop at the first that resolves it:${target === a.defaultBranch ? '' : `\n   FIRST confirm \`${target}\` exists: \`git fetch origin ${target} -q\`. If the fetch fails because the branch does not exist on the remote, the feature has NOT shipped on its integration branch yet: set shipped:false, mark every finding "DECISION" with rationale "integration branch ${target} does not exist yet; cannot triage against code", do NOT close, and return.`}
   a. \`gh issue view ${subIssue} --repo ${a.repo} --json state,stateReason,closedByPullRequestsReferences\`. A MERGED closing PR${target === a.defaultBranch ? '' : ` whose base is \`${target}\``} => shipped (note the PR for context).
   b. No closing-PR link does NOT mean unshipped — issues closed without a "Closes #" keyword have none. Search directly: \`gh pr list --repo ${a.repo} --state merged --search "${subIssue}"\`${target === a.defaultBranch ? '' : ` (prefer a PR whose base is \`${target}\`)`} and \`git fetch origin ${target} -q && git log --oneline --grep "#${subIssue}" origin/${target}\`. A merged PR or merge commit referencing it on \`${target}\` => shipped.
   c. If still unresolved but the issue is CLOSED-as-completed AND the files/symbols the findings name are present at \`${target}\` HEAD => shipped.
   Conclude NOT shipped ONLY when the feature is open/halted AND no merged PR or merge commit references it on \`${target}\` AND its code is absent at \`${target}\` HEAD (e.g. a P0-halted feature, or an integration feature not yet built). Then set shipped:false, mark every finding "DECISION" with rationale "feature not yet shipped; cannot triage against code", do NOT close, and return. A future run triages it once the feature lands.
3. If shipped, judge each finding against the GROUND TRUTH = the current files at \`${target}\` HEAD (read them directly), using any merged PR diffs you found as supporting context. The current code is authoritative even when you cannot pin the exact PR. For EACH finding:
   - RESOLVED — the code at HEAD already does the right thing. Cite the file/line that proves it.
   - FIX_NOW  — a real, small, unambiguous fix. Set confidence "high" only if you are sure the fix is correct, safe, and in-scope (it will be applied and merged with NO human review). Any ambiguity about correctness, scope, or approach => "low".
   - DECISION — needs a human judgment call (a real trade-off, a product/behavior choice, or a fix whose correct form is unclear). Reserve it for genuine choices.
   - MOOT     — the finding was wrong, or the implementation diverged so it no longer applies.
   For EVERY finding you mark DECISION or low-confidence FIX_NOW (i.e. anything that will reach a human), ALSO set these so the operator can be asked with a recommendation-first prompt and the decision can be parked verbatim:
     - decision_question  — one crisp line stating the choice the operator must make (outcome-framed, not implementation minutiae).
     - recommended_answer — your single best answer (becomes the first, "(Recommended)" option). Make a real call; only say it's a toss-up if it genuinely is.
     - alt_options        — 1-3 realistic alternative answers, each a short outcome-framed label.
   Leave these null/empty on RESOLVED, MOOT, and high-confidence FIX_NOW findings.
4. Post ONE triage comment on the residual summarizing each finding's verdict + one-line rationale (\`gh issue comment ${residualUrl} --body-file <(...)\`).
5. CLOSE the residual ONLY if every finding is RESOLVED or MOOT (no action remains): \`gh issue close ${residualUrl} --comment "Triaged: all findings resolved in shipped code or moot. <one line>"\` and set closed:true. Otherwise leave it open (high-confidence FIX_NOW findings are auto-fixed in a later sweep; DECISION / low-confidence findings await a human) and set closed:false.

Be conservative about closing and about high-confidence: closing a real issue or auto-merging a wrong fix is worse than leaving a residual open for a human.

Return structured output: { residual_issue, sub_issue, shipped, closed, findings: [{title, severity, verdict, confidence, rationale, fix_hint, decision_question, recommended_answer, alt_options}] }. Set sub_issue to the underlying feature #${subIssue}.`;

const decisionFindings = (tr) =>
  ((tr && tr.findings) || []).filter(
    (f) => f.verdict === 'DECISION' || (f.verdict === 'FIX_NOW' && f.confidence !== 'high'),
  );

const parkResidualPrompt = (a, tr, residualUrl) => `You are PARKING one cw-review-residual issue for the operator's input, using gh via Bash. Repo ${a.repo}. Residual: ${residualUrl} (#${tr.residual_issue}, feature #${tr.sub_issue}). Its findings against the shipped code include genuine judgment calls only the operator should make.

Steps:
1. Fetch the current body: \`gh issue view ${tr.residual_issue} --repo ${a.repo} --json body -q .body > body.md\`.
2. Write the decisions into body.md as a "## Decision needed" block — one numbered entry per decision below, each showing the question, your recommended answer, and the alternatives. If a "## Decision needed" block already exists (a prior park), REPLACE it in place rather than appending a second one. The decisions:
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
   Use \`gh issue edit ${tr.residual_issue} --repo ${a.repo} --body-file body.md\` (never hand-escape backticks or checklists).
3. Flip labels to the parked state: \`gh issue edit ${tr.residual_issue} --repo ${a.repo} --add-label cw-review-residual:needs-input --remove-label cw-review-residual:go\` (create cw-review-residual:needs-input first if missing: color D93F0B). Do NOT add cw-review-residual:go — that is the operator's action.

Return structured output: { issue: ${tr.residual_issue}, parked: true }.`;

const autofixPrompt = (a, tr, target) => `You are implementing ONLY a set of small, high-confidence cleanup fixes for cw-review-residual #${tr.residual_issue} (sub-issue #${tr.sub_issue}) in an isolated git worktree, headless, with no human. Do NOT merge; the orchestrator merges serially after you return.

Repo ${a.repo}. MERGE TARGET for this residual: \`${target}\`${target === a.defaultBranch ? ` (the repo's default branch).` : ` — this residual's umbrella carries a cw-target:<slug> label, so its feature integrates on \`${target}\`, NOT ${a.defaultBranch}. Fork from, precheck against, and open the PR against \`${target}\` (it carries the feature's accumulated work). Do NOT touch ${a.defaultBranch}.`} Implement EXACTLY these triaged fixes and nothing more:
\`\`\`json
${JSON.stringify(highConfidenceFixes(tr).map((f) => ({ title: f.title, fix_hint: f.fix_hint, rationale: f.rationale })), null, 2)}
\`\`\`

FRESHNESS PRE-CHECK — do this FIRST, before branching or writing any code. The triage that produced these fixes is a snapshot and may be stale: between triage and now, a parallel PR or another session can close the residual or land an equivalent fix on \`${target}\`. Building a PR for already-done work burns a PR + CI cycle for nothing — this check prevents exactly that.
- a. Confirm the residual is still OPEN: \`gh issue view ${tr.residual_issue} --repo ${a.repo} --json state,closedByPullRequestsReferences\`. If it is CLOSED, STOP: do not branch or open a PR; report ready_to_merge:false, cause "residual #${tr.residual_issue} already closed since triage".
- b. \`git fetch origin ${target} -q\`, then for each listed fix read the file(s) it would touch at fresh \`origin/${target}\` HEAD and DROP any whose change is already present (an equivalent guard/test/code merged since triage — search for the symbol/test name, do not assume). If EVERY listed fix is already on \`${target}\`, STOP: report ready_to_merge:false, cause "fixes already landed on ${target} (equivalent work merged since triage)". Otherwise proceed with ONLY the fixes that are genuinely still needed.

Steps:
1. Branch off fresh \`${target}\` in your worktree.
2. Implement ONLY the listed fixes. Stay strictly in scope. If a "fix" turns out to be larger, ambiguous, or riskier than its description, SKIP it and record that in \`cause\` rather than expanding scope or guessing.
3. Follow repo conventions (AGENTS.md/CLAUDE.md): regenerate generated files rather than hand-editing; add or extend tests for changed behavior; keep coverage above the repo bar. Run the build + test suite; tests must pass before you open a PR.
4. Open a PR${target === a.defaultBranch ? '' : ` against \`${target}\` (\`gh pr create --base ${target}\` — it must land on the integration branch, never ${a.defaultBranch})`}. Conventional-commit title (\`fix\`/\`test\`/\`docs\`/\`chore\` scope as fits). Body: Summary + Test plan. ${closeDisposition(tr) === 'close-via-autofix' ? `Include \`Closes #${tr.residual_issue}\` on its own line — these fixes resolve every remaining actionable finding.` : `Include \`Relates to #${tr.residual_issue}\` on its own line. Do NOT close it: unresolved DECISION/low-confidence findings remain for a human.`} Push the branch.
5. Run a code-review pass on your own diff. A P0 is a correctness/security/data-loss/scope finding that must not merge. Fix and re-review if you can; if a P0 cannot be safely auto-fixed here, leave the PR open and report p0:true.
6. Report issue=${tr.residual_issue}, the PR number/URL, branch, the PR's actual base branch as \`base_branch\`, files changed, and your verdict.

If you cannot reach green build + passing tests + clean review, report ready_to_merge:false with the cause rather than papering over it.

Return structured output: { issue, ready_to_merge, p0, pr_number, pr_url, branch, base_branch, changed_paths, cause }.`;

const mergePrompt = (a, built, target) => `You are performing a SERIALIZED merge of one already-built PR to \`${target}\` in repo ${a.repo}, headless, with no human. Only one merge runs at a time; you are it right now.${target === a.defaultBranch ? '' : `\nThis residual's umbrella carries a cw-target:<slug> label, so the PR lands on the integration branch \`${target}\`, NOT ${a.defaultBranch}. The whole feature is promoted to ${a.defaultBranch} later by /cw-promote.`}

PR #${built.pr_number} (${built.pr_url}), branch \`${built.branch}\`, residual #${built.issue}.

Steps:
1. \`git fetch origin ${target} ${built.branch}\`.
2. PRE-MERGE CONFLICT CHECK against FRESH ${target}: \`git merge-tree --write-tree --name-only origin/${target} origin/${built.branch}\`. If it reports a conflict, do NOT merge: try ONE clean rebase of the branch onto fresh ${target} and push with --force-with-lease; if it still conflicts or needs human judgment, report merged:false, cause "pre-merge conflict against ${target}".
3. If clean: \`gh pr merge ${built.pr_number} --repo ${a.repo} --squash --admin --delete-branch\`.
4. Verify: PR state is MERGED; branch is gone (\`git ls-remote --heads origin ${built.branch}\` empty — if not, \`git push origin --delete ${built.branch}\`).
5. Post-merge CI: check ${target} CI for the merge commit is green.

Green = PR MERGED AND post-merge ${target} CI green. Anything else is not green; report the cause. Never force-resolve a conflict.

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
log(`Discovered ${residuals.length} open cw-review-residual issue(s).`);
if (residuals.length === 0) {
  return { repo: cfg.repo, triaged: [], autofixed: [], parked: [], escalations: [], awaiting_input: [], deferred_residuals: [], target_mismatches: [] };
}

// Route by park/resolve/go state: triage fresh + answered (go, in consume mode);
// leave residuals still awaiting the operator (needs-input) untouched.
const awaitingInput = residuals
  .filter((r) => r.human_state === 'needs-input')
  .map((r) => r.residual_issue)
  .sort((a, b) => a - b);
const toTriage = residuals.filter((r) => r.human_state !== 'needs-input');
if (awaitingInput.length) {
  log(`Skipping ${awaitingInput.length} residual(s) awaiting operator input: ${awaitingInput.join(', ')}.`);
}

// --- Triage (classify + close), one subagent per residual, in parallel -----
phase('Triage');
const triageResults = (
  await parallel(
    toTriage.map((r) => () =>
      agent(
        triagePrompt(
          cfg,
          r.sub_issue,
          r.residual_url,
          r.chain || [],
          r.human_state === 'go' ? 'consume' : 'fresh',
          r.target_branch || cfg.defaultBranch,
        ),
        {
          label: `triage:${r.residual_issue}`,
          phase: 'Triage',
          schema: TRIAGE_SCHEMA,
        },
      ),
    ),
  )
).filter(Boolean);
const closedCount = triageResults.filter((t) => t.closed).length;
log(`Triaged ${triageResults.length}; closed ${closedCount}.`);

// Per-residual merge/ground-truth target, derived in Discover from the umbrella's
// cw-target:<slug> label. One sweep commonly mixes residuals from different
// umbrellas, so look it up per residual rather than baking one branch into the
// run. The default-branch fallback keeps an older Discover payload (no
// target_branch) behaving as before.
const targetFor = (residualIssue) => {
  const r = residuals.find((x) => x.residual_issue === residualIssue);
  return (r && r.target_branch) || cfg.defaultBranch;
};

// --- Autofix sweep (opt-in), sequential over a quiescent target branch -------
const autofixed = [];
// Records feeding targetMismatches(): the derived target vs. the autofix PR's
// actual base. Populated only when a PR was opened (built.base_branch present).
const targetCheck = [];
if (runAutofix) {
  phase('Autofix');
  const queue = autofixCandidates(triageResults);
  log(`Autofix queue: ${queue.length} residual(s) with high-confidence fixes.`);
  for (const residualIssue of queue) {
    const tr = triageResults.find((t) => t.residual_issue === residualIssue);
    const target = targetFor(residualIssue);
    const built = await agent(autofixPrompt(cfg, tr, target), {
      label: `autofix:${residualIssue}`,
      phase: 'Autofix',
      isolation: 'worktree',
      schema: BUILD_SCHEMA,
    });
    if (built && built.base_branch) {
      targetCheck.push({
        residual_issue: residualIssue,
        sub_issue: tr.sub_issue,
        target_branch: target,
        actual_base: built.base_branch,
      });
    }
    if (!built || !built.ready_to_merge || built.p0) {
      autofixed.push({
        residual_issue: residualIssue,
        pr: built?.pr_url || null,
        merged: false,
        cause: built?.p0 ? 'P0 on autofix diff; PR left open' : built?.cause || 'autofix build not mergeable',
      });
      continue;
    }
    const mResult = await agent(mergePrompt(cfg, built, target), {
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

// --- Park decisions: write the "## Decision needed" block + needs-input -----
// Durable park for the operator. Headless runs leave these waiting for /cw-resolve;
// an interactive caller drains them immediately from report.escalations.
const parked = [];
phase('Park');
const parkQueue = parkCandidates(triageResults);
log(`Park queue: ${parkQueue.length} residual(s) with judgment calls.`);
if (parkQueue.length) {
  const parkResults = await parallel(
    parkQueue.map((residualIssue) => () => {
      const tr = triageResults.find((t) => t.residual_issue === residualIssue);
      const url = `https://github.com/${cfg.repo}/issues/${residualIssue}`;
      return agent(parkResidualPrompt(cfg, tr, url), {
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
  parked: parked.sort((a, b) => a - b),
  escalations: escalations(triageResults),
  awaiting_input: awaitingInput,
  deferred_residuals: deferredResiduals(triageResults),
  // SOFT diagnostic (Step 3 section): autofix PRs whose base disagrees with the
  // residual's derived target. Report-only — never an escalation or a cause.
  target_mismatches: targetMismatches(targetCheck),
};
log(
  `Done. triaged=${report.triaged.length} closed=${report.triaged.filter((t) => t.closed).length} ` +
    `autofixed=${report.autofixed.filter((a) => a.merged).length}/${report.autofixed.length} ` +
    `parked=${report.parked.length} escalations=${report.escalations.length} ` +
    `awaiting=${report.awaiting_input.length} deferred=${report.deferred_residuals.length} ` +
    `target_mismatches=${report.target_mismatches.length}`,
);
return report;
