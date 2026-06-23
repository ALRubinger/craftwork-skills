---
name: cw-orchestrate
description: Take a GitHub umbrella issue's sub-issues from "open" to "merged PRs" via one interactive readiness sweep followed by a hands-off Claude Code Workflow that plans, reviews, schedules by dependency, and works each sub-issue through to a serialized squash-merge. Trigger when the user wants to orchestrate, fan out, or batch-execute the sub-issues of a parent/umbrella/tracking issue.
metadata:
  version: "0.1.0"
  triggers:
    - orchestrate.?umbrella
    - umbrella.?issue
    - orchestrate.?(the|this)?.?(parent|tracking).?issue
    - fan.?out.?(the)?.?sub.?issues
    - batch.?(execute|run).?sub.?issues
    - take.?(the)?.?sub.?issues.?to.?(merged)?.?prs?
---

# cw-orchestrate

Take a parent (umbrella) issue's open sub-issues from "open" to "merged PRs."

The skill runs **one interactive readiness sweep** in the main session — the single human touchpoint — then writes a per-run **manifest** and launches a background **Claude Code Workflow** that plans, doc-reviews, schedules by dependency, and works each sub-issue through to a serialized, safety-gated squash-merge. After you say "go," no further human input is solicited until the run reports back. Once it does, the main session reconciles GitHub state — closing merged-but-open sub-issues, labeling any sub-issue the run left parked (`cw-status:stalled`/`cw-status:deferred`), and updating the parent issue so GitHub stays the source of truth (Step 7) — then cleans up its own worktrees and branches and heals the checkout to the run's merge target (Step 8), so a completed run leaves both GitHub and the repo tidy. On an integration-target run (a `cw-target:<slug>` label on the umbrella) the PRs land on `integration/<slug>` instead of the default branch, the checkout heals to that branch, and the umbrella stays open for cw-promote (#39) rather than closing.

This skill is umbrella-agnostic: it operates on any parent issue with sub-issues. #989 (agent-auth) is the first run, not a special case.

## When to Use

Use when the user points at a parent/umbrella/tracking issue and wants its sub-issues taken to merged PRs with minimal hand-holding, e.g. "orchestrate #989", "fan out the sub-issues of this umbrella", "batch-run the agent-auth track."

Do **not** use for a single issue (just plan + work it directly), or when the user wants to stay in the loop on every plan and merge (that is the normal one-session-at-a-time flow).

## Prerequisites

### Required tools
- `gh` (GitHub CLI) — verify `gh auth status`
- `git`
- The **Workflow** tool (Claude Code "Dynamic Workflows", shipped 2026-05-28). The skill launches `workflow.js` via the Workflow tool's `scriptPath` input.

### Required state
- A GitHub repo with a parent issue that has open sub-issues.
- Standing PR-shepherd authorization for this repo family (squash-merge with `--admin`, `--force-with-lease` rebase, branch-deletion verification). See your repo's merge conventions (e.g. an `AGENTS.md` / `CLAUDE.md`).

### Reference files (this skill)
- [references/readiness-sweep.md](./references/readiness-sweep.md) — sweep routing + brief-completeness gate
- [references/manifest-schema.md](./references/manifest-schema.md) — manifest + brief contract (the sweep → Workflow handoff)
- [references/subagent-roles.md](./references/subagent-roles.md) — plan / review / work role prompts + output schemas (mirrors what `workflow.js` inlines)
- [references/residual-triage.md](./references/residual-triage.md) — triage + autofix roles: re-judge filed residuals against shipped code, close/fix/escalate
- [references/merge-safety.md](./references/merge-safety.md) — serialization, pre-merge `git merge-tree`, P0 / conflict halt rules

The skill is fully executable from `SKILL.md` alone; the reference files carry the detail.

## Workflow

### Step 0: Load repository instructions

Before anything, search for `AGENTS.md` / `CLAUDE.md` in the target repo and load build/test/merge guidance. The Workflow's work subagents must honor it (squash, `--admin`, branch-deletion verification, coverage bar). Note the repo's default branch — the rest of the run assumes it.

### Step 1: Resolve the umbrella and enumerate open sub-issues

**Arguments:** `<umbrella>` (required — parent issue number or URL) and an optional scope filter:

- `--only <n[,n...]>` — run on only these sub-issue numbers (everything else is excluded from the sweep and the run).
- `--except <n[,n...]>` — run on all open sub-issues except these.

The scope filter is the supported way to do a **de-risked first run** — e.g. `989 --only 981` proves the full plan → review → work → serialized-merge path on the linchpin alone before fanning out the rest. It is also how you resume after a partial run (re-invoke with `--only` the stalled issues). Absent a filter, every open sub-issue is in scope.

Enumerate the umbrella's **open** sub-issues:

```bash
umbrella="$1"        # e.g. 989
# optional: ONLY="981,985"   or   EXCEPT="982"
gh issue view "$umbrella" --json number,title
# Sub-issues are GitHub native sub-issues — enumerate the open ones directly.
gh issue view "$umbrella" --json subIssues --jq '.subIssues[] | select(.state=="OPEN") | .number'
```

If `subIssues` is **empty** but the umbrella body still carries a `- [ ] #NNN` checklist, it is a legacy umbrella that predates native sub-issues. Don't parse the checklist — **migrate it** to native sub-issues first (cw-scope's porting recipe in [references/issue-templates.md](../cw-scope/references/issue-templates.md)), so the run and every later reader see one source of truth.

Resolve each candidate to `{number, title, state}` and drop anything not `OPEN`. Closed sub-issues are excluded (R1). Then apply the scope filter: if `--only` is set, keep only those numbers (error if any named number is not an open sub-issue of the umbrella); if `--except` is set, drop those. Present the resulting in-scope set to the operator before sweeping, and state explicitly which sub-issues were excluded by scope so the run's blast radius is unambiguous.

**Read the umbrella's merge target.** The `cw-target:<slug>` **label on the umbrella is the single source of truth** for where this run's PRs land (set by cw-scope; see its [integration-branch targeting convention](../cw-scope/references/issue-templates.md#integration-branch-targeting-cw-targetslug)). There is no body field and no per-sub-issue label — **sub-issues inherit the umbrella's target** (no duplicated state). Read the labels and derive the target with this skill's `target.mjs` (the single, tested slug→branch derivation):

```bash
# Single source of truth: the cw-target:<slug> label on the umbrella.
mapfile -t labels < <(gh issue view "$umbrella" --json labels --jq '.labels[].name')
# Derive { targetBranch, slug } from the labels (target.mjs encodes the rules):
#   0 cw-target:* labels  -> { targetBranch: null }  (defaults to defaultBranch)
#   1 cw-target:* label   -> integration/<slug>
#   >1 cw-target:* labels -> abort (operator removes the extra label)
#   empty/whitespace slug -> hard stop (never silently falls back)
node -e 'import("./skills/cw-orchestrate/target.mjs").then(m => {
  console.log(JSON.stringify(m.deriveTarget(process.argv.slice(1))));
})' "${labels[@]}"
```

Surface the helper's errors to the operator **before** "go", and stop the sweep on either:

- **Multiple `cw-target:*` labels** ⇒ abort with the helper's error (it names the conflicting labels). The operator removes the extra label and re-invokes — orchestrate does not guess which target was intended.
- **Empty / whitespace-only slug** (`cw-target:` or `cw-target:   `) ⇒ hard-stop with the helper's error. Never silently fall back to `defaultBranch`; a malformed label is an operator mistake to fix, not a default to absorb.

A clean derivation yields either `targetBranch: "integration/<slug>"` (label present) or `targetBranch: null` (label absent ⇒ the run lands on `defaultBranch`, behavior unchanged). Carry the derived `{ targetBranch, slug }` forward to Step 4 (manifest) and Step 4.5 (ensure the branch exists).

### Step 2: Run the interactive readiness sweep

Follow [references/readiness-sweep.md](./references/readiness-sweep.md). For **each** open sub-issue, in order:

1. Read the issue and scan the repo for the decisions a plan would need — scope ambiguities, unstated behavior, design forks (R2).
2. Route the issue to one of three states using the blocking-question tool (one question at a time):
   - **ready** — clear enough to plan as-is.
   - **clarify-now** — resolve the open questions with the operator inside the sweep.
   - **back-off-to-brainstorm** — too under-specified; invoke `ce-brainstorm` interactively; its requirements doc becomes (or is linked by) the brief (R2, AE1).
3. Write the issue's **readiness brief** (resolved decisions, answered clarifications, constraints) per [references/manifest-schema.md](./references/manifest-schema.md) (R5).

After all issues are routed and briefed, run the **brief-completeness gate** (R3): for each brief, name the gaps a planner would otherwise invent and surface them to the operator to fill or explicitly accept. No brief proceeds carrying silent unstated assumptions (AE4).

### Step 3: Declare logical dependencies

Ask the operator to declare logical dependencies between sub-issues — "B's implementation needs A's merged code," even with no file overlap (R6, R8). Record them as `depends_on` edges. Validate the edges form a DAG; reject cycles with a clear error naming the cycle (the scheduler also re-checks, but catch it here while the operator is present).

**Out-of-scope dependencies (scope filter).** When `--only` / `--except` narrows the run, an in-scope issue may declare a `depends_on` on an excluded issue. Prune such edges from the manifest — the scheduler rejects a `depends_on` that names an issue not in `issues[]` — and **warn the operator explicitly**: the pruned prerequisite must already be merged on the default branch, otherwise the dependent will likely hit a build or merge failure and stall. This is the one sharp edge of a scoped run; surface it, don't bury it. (For the de-risked first run, prefer scoping to a dependency-free issue like the linchpin #981 so no pruning is needed.)

File-contention ordering is **not** declared here — the Workflow computes it later from the plans' predicted ownership tables.

### Step 4: Write the manifest and confirm "go"

Write the manifest per [references/manifest-schema.md](./references/manifest-schema.md):

```json
{
  "umbrella": 989,
  "repo": "<owner>/<repo>",
  "defaultBranch": "main",
  "runId": "umbrella-989-20260611-1713",
  "timestamp": "2026-06-11T17:13:00Z",
  "issues": [
    { "number": 981, "brief_path": "<abs path>/981.md", "depends_on": [] },
    { "number": 984, "brief_path": "<abs path>/984.md", "depends_on": [981] }
  ]
}
```

- `runId` and `timestamp` are generated **here, in the main session** (the Workflow forbids `Date.now()` / `Math.random()`; they arrive via `args`).
- `targetBranch` is optional (omitted above): it defaults to `defaultBranch`. Set it from the Step 1 derivation: when a `cw-target:<slug>` label was present, the derived `targetBranch` is `integration/<slug>`, so **write `targetBranch: "integration/<slug>"`** into the manifest; when the label was absent (`targetBranch: null`), **omit the field entirely** so the Workflow lands PRs on `defaultBranch`. Manifest invariant 5 (present ⇒ non-empty) is satisfied by construction — the empty/whitespace-slug case already hard-stopped in Step 1, so a present value is always a real branch name. See manifest-schema.md for the base-vs-target split.

  A worked **integration-target** manifest (label `cw-target:agent-auth` present) carries the populated field:

  ```json
  {
    "umbrella": 989,
    "repo": "<owner>/<repo>",
    "defaultBranch": "main",
    "targetBranch": "integration/agent-auth",
    "runId": "umbrella-989-20260611-1713",
    "timestamp": "2026-06-11T17:13:00Z",
    "issues": [
      { "number": 981, "brief_path": "<abs path>/981.md", "depends_on": [] }
    ]
  }
  ```

- Briefs and the manifest live under a run-scoped working directory the background Workflow can read by absolute path (see manifest-schema.md for the location decision).

Then get an explicit **"go"** from the operator (AskUserQuestion). This is the last human checkpoint (R4). Show the routed list, the dependency edges, the manifest path, and **the run's merge target** — `integration/<slug>` when a `cw-target:` label was derived, or "default branch (`<defaultBranch>`)" when absent — before asking, so the operator sees the run's blast radius (where PRs will land) before approving.

### Step 4.5: Ensure the integration branch exists and is fresh (target runs only)

**This runs only when a `targetBranch` was derived in Step 1** (a `cw-target:<slug>` label is present). On the label-absent path it is a **no-op** — there is no integration branch to ensure, and behavior is unchanged.

The headless Workflow assumes the merge target already exists and is current: it branches work off fresh `defaultBranch`, but the pre-merge `git merge-tree` check and the squash-merge both target `integration/<slug>`. So the **main session** creates the branch if missing and refreshes it from `main` here, before launch. Honor [worktree-discipline](./references/worktree-discipline.md): never operate on the primary checkout's default branch directly — use a remote-ref push or a scratch worktree.

The recipe is idempotent — safe to re-run on a resumed run:

```bash
# Only when a target was derived in Step 1:
slug="agent-auth"                       # from Step 1
target="integration/${slug}"

git fetch origin main
if [ -z "$(git ls-remote --heads origin "$target")" ]; then
  # Missing: create it off fresh origin/main and push (no local checkout needed).
  git push origin "refs/remotes/origin/main:refs/heads/${target}"
else
  # Exists: merge main in to keep the merge-tree base current. Do it on a
  # scratch worktree so the primary checkout's branch is never touched.
  git fetch origin "$target"
  wt=".cw-orchestrate/refresh-${slug}"
  git worktree add --force "$wt" "origin/${target}"
  git -C "$wt" merge --ff-only "origin/main" \
    || git -C "$wt" merge --no-edit "origin/main"   # real merge only if main diverged
  git -C "$wt" push origin "HEAD:${target}"
  git worktree remove --force "$wt"
fi
```

If a real (non-fast-forward) merge of `main` into the integration branch hits a conflict, surface it to the operator before "go" — a stale integration branch with conflicts against `main` is an operator decision, not something to resolve unattended. State explicitly that the Workflow runs from its launch snapshot, so this ensure step must complete before Step 5.

### Step 5: Launch the Workflow

After "go," launch the background Workflow with the manifest as `args`:

> Invoke the **Workflow** tool with `scriptPath` pointing at this skill's `workflow.js`, and `args` set to the manifest object (the manifest itself, not a path to it). The Workflow runtime delivers `args` to the script as a JSON **string**, so `workflow.js` parses it before use — pass the object and the script handles marshaling. The Workflow runs headless in the background; you will be notified on completion. Do not poll.

The Workflow performs, in order (see `workflow.js` and [references/subagent-roles.md](./references/subagent-roles.md)):

1. **Plan** — a plan subagent per ready issue, in parallel, each emitting a plan + a machine-parseable file-ownership table (R7, R8).
2. **Review (Stage 1.5)** — a doc-review subagent per plan; a P0 finding halts that sub-issue (and its dependents) and files a `cw-review-residual` issue; non-P0 findings file-and-proceed (R9, R10, R11, AE3).
3. **Pre-flight schedule** — declared deps ∪ file-overlap (set-intersection over ownership tables) → ordered waves (R12, AE2, AE6).
4. **Work** — a work subagent per node in wave order, each in its own worktree, taking the issue through implementation → PR → serialized squash-merge with the full merge-safety contract (R13–R16, AE5).
5. **Triage** — the moment a node merges, its filed `cw-review-residual` issue is re-judged against the now-shipped diff: each finding classified `RESOLVED` / `FIX_NOW` / `DECISION` / `MOOT`, a triage comment posted, and the residual closed if nothing actionable remains. Fired without holding the merge lock. See [references/residual-triage.md](./references/residual-triage.md).
6. **Autofix** — a final sweep over the now-quiescent default branch: each residual with a high-confidence `FIX_NOW` finding gets one PR (implementing only those fixes) serial-merged through the same contract. Low-confidence fixes and `DECISION` findings are **not** auto-applied — they become escalations.
7. **Failure policy + report** — a non-green node halts its transitive dependents and lets independents finish; the run returns a structured report (R17, R18, AE4-failure).

### Step 6: Surface the report

On completion the Workflow returns:

```json
{
  "merged":    [{ "issue": 981, "pr": "https://github.com/.../pull/NNN" }],
  "stalled":   [{ "issue": 984, "cause": "pre-merge conflict against main; re-queued and unresolved" }],
  "residuals": [{ "issue": 985, "url": "https://github.com/.../issues/MMM", "p0": true }],
  "triaged":   [{ "residual_issue": 1000, "sub_issue": 986, "shipped": true, "closed": true, "disposition": "close-now" }],
  "autofixed": [{ "residual_issue": 992, "pr": "https://github.com/.../pull/NNN", "merged": true, "cause": null }],
  "escalations": [{ "residual_issue": 1010, "sub_issue": 984, "title": "...", "verdict": "DECISION", "confidence": null, "rationale": "..." }],
  "deferred_residuals": [1010]
}
```

Render it in the main session (R18): which issues merged clean, which stalled and why, which residual issues were filed (with links). Distinguish "merged clean" from "merged with filed residuals" per sub-issue (Success Criteria).

The run now also **clears its own residuals** as it goes: `triaged` lists residuals re-judged against shipped code and whether each was closed; `autofixed` lists the high-confidence fixes that were applied and merged. The only items that need the operator's attention are **`escalations`** (genuine judgment calls + fixes the classifier wasn't confident enough to auto-apply) and **`deferred_residuals`** (residuals whose sub-issue didn't ship this run — re-triaged on a later run). Surface those two prominently; the closed/autofixed residuals are done. Any residual still open after the run remains structured so a **future** `cw-orchestrate` run can adopt it as a sub-issue (R11, R20), and the standalone `cw-sweep` skill can re-triage the backlog on demand.

### Step 7: Reconcile the umbrella and referenced issues (GitHub is the source of truth)

GitHub is the authoritative record of what work is done and still needs doing. The run does **not** keep it current on its own: a squash-merge auto-closes a sub-issue only when its PR body carried a `Closes #NNN` keyword, and a parked sub-issue's status label and the parent issue never update themselves. So after the report, reconcile every issue the run touched so a reader sees the true state on GitHub without consulting the run logs. This is the umbrella-specific application of the [issue-reconciliation contract](./references/issue-reconciliation.md) (shared with cw-ship and cw-sweep); the steps below specialize it to the manifest's sub-issues, the umbrella, and its parent.

1. **Re-read live state.** For every sub-issue in the manifest, `gh issue view <n> --json state,stateReason`. For each merged node, confirm its PR is `MERGED` and whether the issue auto-closed (`gh pr view <pr> --json closingIssuesReferences`).
2. **Close merged-but-open sub-issues.** A node whose PR merged green but whose issue is still `OPEN` (the PR omitted a closing keyword) → `gh issue close <n> --comment "Merged via PR #<pr>. <one line>"`. Never close a **stalled** node's issue — its PR is open or its work is incomplete.
3. **Reflect each sub-issue's state natively — no checklist.** Sub-issues are native sub-issues, so a merged one is already **closed** and the umbrella's sub-issue widget rolls that up on its own; there is no checkbox to tick. For a still-open sub-issue the run left parked, set its status label and upsert its reason comment so the widget reads true (per the [issue-reconciliation contract](./references/issue-reconciliation.md) rule 2):
   - **stalled** (run): `gh issue edit <n> --add-label cw-status:stalled` and upsert a `<!-- cw:status -->` comment `⏸ stalled: <cause>, PR #NNN open`.
   - **deferred/excluded** (scope filter): `gh issue edit <n> --add-label cw-status:deferred` and upsert `⏸ deferred: <why>`.
   - On a merged/closed sub-issue, **remove** any `cw-status:*` label.

   Create the two labels lazily on first use (`gh label create cw-status:stalled --color D93F0B …`, `cw-status:deferred --color FBCA04 …`). Then maintain the umbrella body's **residual** section only (it is not a sub-issue duplicate): a short dated **Status** line and a **Residual follow-ups** list, **each residual annotated with its triage disposition** — `closed (resolved/moot)`, `closed via PR #NNN` (close-via-autofix), `open — escalation: <one-line>` (keep-open, needs a human), or `deferred — feature not yet shipped`. This mirrors `cw-sweep`'s Step 4 so the in-band and out-of-band paths leave the residual section identically true. Apply body edits with `gh issue edit <umbrella> --body-file <file>` — a body-file (or quoted heredoc) preserves backticks; do not hand-escape.
4. **Post a run-summary comment on the umbrella**: the merged / stalled / deferred table, residual links, and any production bug the shepherding surfaced.
5. **Close the umbrella when it is fully done — but never on an integration-target run.** When this run's `targetBranch` is an **integration branch** (a `cw-target:<slug>` label was derived), **do not close the umbrella** even if every sub-issue and residual is resolved. The PRs landed on `integration/<slug>`, not the default branch — the work is not yet in production. Closing the umbrella and promoting the integration branch is **cw-promote's job (#39)**; the umbrella stays **open**, tracking the integration branch until it is promoted. Do everything else in this step identically (close merged sub-issues, set status labels, post the run-summary comment) — only the umbrella-close decision branches.

   When `targetBranch === defaultBranch` (label absent — the default path), the existing close logic is unchanged: after sub-issue state is reconciled, if **every** in-scope sub-issue is resolved (merged or closed) **and** none carries `cw-status:deferred`/`cw-status:stalled` **and** no residual is left `open — escalation` (closed/moot/autofixed residuals are fine), close the umbrella itself: `gh issue close <umbrella> --reason completed --comment "All sub-issues and residuals resolved. <one-line outcome>"`. Otherwise leave it **open** — an umbrella whose sub-issues are all closed should close, but any sub-issue still open (parked or in flight) or a live escalation means it is still tracking work. Never close an umbrella that still carries unresolved items.
6. **Update the parent issue the umbrella names** (e.g. a `Parent: #747` line). If the parent has a checklist entry for the umbrella, flip it to `[x]` **only when every in-scope sub-issue is resolved** (nothing deferred or stalled remaining); otherwise leave it unchecked and post a progress comment so the milestone reflects partial completion. Never mark a parent line done while the umbrella still carries open deferred/stalled items.
7. **Update sub-issue descriptions that diverged from what shipped.** When a node's implementation took a different approach, or narrowed/broadened scope, or split follow-ups into new issues, edit that **sub-issue's body** so its description matches what actually shipped — don't close it still describing a plan that didn't happen (contract rule 4). Only where the description would now mislead; skip nodes that shipped as written.
8. **Reconcile cross-referenced issues.** Beyond the manifest and the named parent, reconcile any **other** issue the run's PRs or sub-issue bodies `Relates to` / `Part of` / mention (contract rule 5): tick its tracker line, close it if a node fully resolved it, or post a one-line "addressed by PR #<pr>" so the reference isn't left stale. Enumerate them from the merged PRs' bodies and the sub-issue bodies.
9. **Verify.** Re-read the umbrella's sub-issue widget (`gh issue view <umbrella> --json subIssues`), the closed sub-issues, any `cw-status:*` labels, and any cross-referenced issues to confirm the edits landed.

The invariant: when the run ends, the umbrella, its sub-issues, and its parent on GitHub all reflect the true current state — including the umbrella itself closed when (and only when) everything under it is resolved. Reconciliation runs **before** local cleanup (Step 8) — GitHub truth first, local tidiness second.

### Step 8: Clean up the run's worktrees and local branches

This step *heals* the primary checkout after the fact; the standing invariant that keeps it healable — all work in worktrees, the primary checkout's default branch a pure fast-forward mirror of `origin` — and the `pre-commit` hook that enforces it are in [references/worktree-discipline.md](./references/worktree-discipline.md).

After the report is surfaced, the main session removes the debris the background Workflow leaves behind. The Workflow's work subagents run with `isolation: 'worktree'`, so each leaves a `wf_<workflowRunId>-NN` worktree **and** a local feature branch. The serialized merge step's `gh pr merge --delete-branch` deletes the **remote** branch but leaves the local worktree and branch; and because `gh` runs from inside a worktree, its post-merge local cleanup often fails noisily and can leave the default-branch checkout switched onto a feature branch with local `<defaultBranch>` sitting behind the squash commits. Heal all of this automatically, **scoped strictly to this run's artifacts**:

1. **Capture the `workflowRunId`** the Workflow tool returned at launch (e.g. `wf_f589ef2f-d48`). Only worktrees whose path matches `.claude/worktrees/<workflowRunId>-*` are in scope — never other runs' `wf_*` worktrees, never named/human worktrees, never the session's own worktree.
2. **Remove vs. keep is decided by merge state, never by guesswork.** For each in-scope worktree, read its branch (`git worktree list`), then:
   - **Merged + clean** — its PR is `MERGED` (remote branch gone: `git ls-remote --heads origin <branch>` is empty) **and** `git -C <wt> status --porcelain` is empty → `git worktree unlock <wt> 2>/dev/null; git worktree remove --force <wt>; git branch -D <branch>`. Then also delete the worktree's **auto-created placeholder branch** `worktree-<basename-of-wt>` — `git worktree remove` leaves it behind, and it points at a now-merged base commit (verify `git merge-base --is-ancestor worktree-<name> origin/<defaultBranch>` before `git branch -D`). Both the work subagent's feature branch and this placeholder must go for the run to be fully tidy.
   - **Stalled or dirty** — the remote branch still exists (an open PR a human must finish), or the worktree has uncommitted changes → **keep it untouched** and name it in the cleanup summary. A stalled node's worktree is where the fix continues; removing it would destroy in-progress recovery work.
3. **Heal the primary checkout to `<defaultBranch>` — always.** The primary checkout's default branch is a pure fast-forward mirror of `origin` ([worktree-discipline.md](./references/worktree-discipline.md)); the heal must keep it that way, regardless of where the run's PRs landed. `git fetch origin <defaultBranch>`. If the primary checkout (or any surviving worktree) is parked on a now-deleted feature branch, switch it back to `<defaultBranch>` (untracked files are preserved across the switch). Then advance local `<defaultBranch>` **by fast-forward only** to `origin/<defaultBranch>`: `git branch -f <defaultBranch> origin/<defaultBranch>` when nothing has it checked out (a no-op-or-ff because the primary never receives a local commit), else `git -C <checkout> merge --ff-only origin/<defaultBranch>`. Never force a non-ff move and never create a local commit on the primary checkout — if `git log origin/<defaultBranch>..<defaultBranch>` is non-empty the discipline has already been violated upstream; stop and report rather than papering over it with a force.

   **On a target run, advance `integration/<slug>` in a dedicated worktree — never by checking it out in the primary checkout.** The merges landed on `targetBranch` = `integration/<slug>`, but that branch is *not* the primary checkout's concern: parking the primary on it would contradict the fast-forward-mirror invariant. Instead, `git fetch origin <targetBranch>` and update local `<targetBranch>` without ever switching the primary onto it: `git branch -f <targetBranch> origin/<targetBranch>` when nothing has it checked out, or — if a surviving in-scope worktree is parked on it — `git -C <wt> merge --ff-only origin/<targetBranch>` there. If you need a working tree on `<targetBranch>` at all, add a throwaway one (`git worktree add --detach` / a dedicated `integration/<slug>` worktree) rather than borrowing the primary checkout. **Label-absent path:** `targetBranch === <defaultBranch>`, so this second move is the same branch the primary heal above already advanced — skip it (no separate integration branch exists), and the behavior collapses byte-for-byte to today's default-branch heal.
4. `git worktree prune`, then report what was removed and what was deliberately kept (stalled worktrees and their branches).

The merge-state gate is what makes this safe to run unattended: a worktree is removed only when its work is provably on the run's `targetBranch` (the merge target — `<defaultBranch>` on the label-absent path) and the tree is clean. Never remove a worktree with uncommitted changes or an unmerged branch, and never touch the run-scoped `.cw-orchestrate/<runId>/` scratch on a run that stalled (its briefs/manifest aid the re-run).

## Key Notes

- **The sweep is the only human touchpoint.** Everything after "go" is hands-off by design. If a sub-issue is not ready, resolve it in the sweep — do not rely on the headless planner to invent the missing decision.
- **Success is quality, not throughput.** "Nine merged" is a proxy. The bar is PRs an operator would have approved. Every P0 — in a plan or a diff — halts or is filed, never silently shipped (R19).
- **The run cleans up its own residuals.** Filed `cw-review-residual` issues are not left to pile up: each is re-triaged against shipped code as its node merges, closed if resolved/moot, and high-confidence fixes are auto-applied in a final sweep. The confidence gate is load-bearing — only fixes the triage subagent is sure are correct, safe, and in-scope merge unsupervised; everything ambiguous becomes an operator escalation. So a clean run leaves behind only judgment calls and unshipped-feature deferrals, not a technical backlog.
- **Merges are serialized and gated on green CI.** One merge to the default branch at a time; every merge re-runs `git merge-tree` against fresh `main` and then **waits for the PR's own checks to conclude, merging only when every blocking check (build/tests/lint/type/smoke) is green** — it never merges over a pending or failing check (`--admin` bypasses required-review, not validation). Advisory soft gates (coverage thresholds, preview deploys) don't block. A merged node is never relabeled "stalled"; a failing blocking check stalls the node *before* it lands. See [references/merge-safety.md](./references/merge-safety.md).
- **Concurrency model (no per-repo lock).** cw-orchestrate has no coarse run lock and does not use cw-ship's per-issue claim — and deliberately so. It is launched **once per umbrella** behind an interactive readiness sweep (not as an unattended scheduled drainer over a shared backlog), so the cross-run double-processing that the claim guards against doesn't arise. Within a run, the **serial merge loop is the only mutual exclusion** (one node merges to the default branch at a time); the merge step re-checks `git merge-tree` against fresh `main` and rebases/retries when the base moved, so it never assumes a quiescent branch even while a cw-ship/cw-sweep run merges concurrently. Worktree cleanup is run-scoped by `workflowRunId` (Step 8), so concurrent runs never touch each other's artifacts. Running **two orchestrate runs on the same umbrella at once is unsupported** (they'd both process the same open sub-issues); if that ever becomes a need, the per-issue claim from cw-ship's [state-machine.md](../cw-ship/references/state-machine.md) is the pattern to adopt per sub-issue.
- **Determinism.** The Workflow forbids `Date.now()` / `Math.random()` / argless `new Date()`. The `runId` and `timestamp` are minted in the main session and passed through the manifest; the scheduler is a pure function.
- **Git/PR via `gh`/`git`, not MCP.** Background Workflow subagents may not have interactively-authenticated MCP servers; the git/PR path uses `gh` and `git` via Bash, which are always available.
- **Reusable.** Umbrella context loads through the manifest, not a separate config mechanism (R20). Run the skill on any parent issue with sub-issues.
- **Integration-branch targeting (`cw-target:<slug>`).** The umbrella's `cw-target:<slug>` label (single source of truth — no body field, no per-sub-issue labels; sub-issues inherit it) makes the run land its PRs on `integration/<slug>` instead of the default branch. The label is read and the target derived in the sweep (Step 1, via `target.mjs`); multiple `cw-target:*` labels or an empty/whitespace slug abort before "go". The main session ensures the integration branch exists off `origin/main` and merges `main` in for freshness before launch (Step 4.5). The Workflow still branches work off fresh `defaultBranch` but merges onto `targetBranch` (already-shipped plumbing). On a target run the umbrella is **not** closed — that is cw-promote's job (#39) — and the **primary checkout still heals to `<defaultBranch>`** (its fast-forward-mirror invariant holds on every run); the run advances `integration/<slug>` separately, in a dedicated worktree, never by parking the primary checkout on it. Absent the label, every one of these collapses to the default-branch behavior, unchanged.
- **GitHub stays the source of truth (Step 7).** A run reconciles every issue it touched before it ends: merged-but-open sub-issues are closed (squash-merge auto-closes only with a `Closes #NNN` keyword), parked sub-issues are labeled `cw-status:stalled`/`cw-status:deferred` with an upserted reason comment (the native sub-issue widget rolls up the rest), the umbrella itself is closed once every sub-issue and residual is resolved (left open otherwise — and **never** closed on an integration-target run, which defers closing to cw-promote #39), and the parent issue is updated (its umbrella line flips to done only when nothing is left deferred or stalled). Anyone reading the issues sees the true state without the run logs.
- **Self-cleaning (Step 8).** The run removes its own `wf_<runId>-*` worktrees and local branches and heals the **primary checkout to `<defaultBranch>`** (its pure fast-forward mirror of `origin`, on every run) automatically, scoped to this run's prefix and gated on merge state. On a target run it also advances `integration/<slug>` to `origin` — in a dedicated worktree, never by checking it out in the primary checkout. Merged nodes' debris is removed; a stalled node's worktree and branch are preserved so the operator can finish the fix in place.
