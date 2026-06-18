---
name: cw-sweep
description: Triage the backlog of cw-orchestrate `review-residual` issues. Re-judge each filed finding against the code that actually shipped, close the ones already resolved or moot, auto-apply the small high-confidence fixes, and surface only genuine judgment calls. Trigger when the user wants to clear, triage, or act on review-residual issues out of band from an umbrella run.
metadata:
  version: "0.1.0"
  triggers:
    - triage.?(the)?.?residual
    - (clear|clean.?up|process).?(the)?.?review.?residual
    - review.?residual.?(issues|backlog)
    - act.?on.?(the)?.?residual.?(issues|findings)
---

# cw-sweep

Clear the standing backlog of `review-residual` issues that `cw-orchestrate` files.

Each `review-residual` issue is a consolidated set of plan-review findings the umbrella run deferred. Filed against a **plan**, many are already moot by the time the feature ships, others are cheap correct fixes, and only a few are genuine decisions. This skill re-judges every finding against the **shipped code**, then:

- **Closes** residuals whose findings are all already-resolved or moot.
- **Auto-applies** the small, high-confidence fixes (one PR per residual, serial-merged).
- **Escalates** to the operator only the genuine judgment calls and the fixes the classifier wasn't confident enough to apply unsupervised.
- **Defers** residuals whose sub-issue hasn't shipped yet (re-triage on a later run).

`cw-orchestrate` already runs this triage in-band for residuals it files during a run (per-node after merge, plus a final autofix sweep). This skill is for the **backlog** — residuals filed before in-band triage existed, residuals from runs you didn't fully clear, and residuals whose feature shipped only later. The triage and autofix roles are identical; see `cw-orchestrate/references/residual-triage.md` for the canonical role definitions.

## When to Use

When the user wants to triage, clear, or act on `review-residual` issues — e.g. "triage the residual issues", "clear the review-residual backlog", "act on the residuals for umbrella #989". Do **not** use it to triage residuals from a run currently in flight (cw-orchestrate handles those itself).

## Prerequisites

- `gh` (authenticated — `gh auth status`) and `git`.
- The **Workflow** tool. The skill launches `workflow.js` via `scriptPath`.
- The **AskUserQuestion** tool — used to ask the operator each decision when an interactive run surfaces escalations (load its schema via `ToolSearch` `select:AskUserQuestion` if needed).
- Standing PR-shepherd authorization for this repo family (squash-merge with `--admin`, `--force-with-lease` rebase) — only needed when autofix is enabled.

## Workflow

### Step 0: Load repository instructions

Find `AGENTS.md` / `CLAUDE.md` in the target repo and note build/test/merge conventions (squash, `--admin`, coverage bar, generated-file regen) and the default branch. The autofix subagents must honor them.

### Step 1: Resolve scope

Decide which residuals are in scope and confirm with the operator:

- **Whole backlog** — every open `review-residual` issue in the repo.
- **One umbrella** — residuals whose body references `Umbrella #<n>` (pass `umbrella`).
- **Explicit set** — specific residual issue numbers (pass `only: [n, ...]`).

Also confirm whether to run **autofix**. Default is on. With autofix off, the run only classifies and closes (resolved/moot) and reports the rest — nothing lands code. Recommend autofix-off for a first pass on an unfamiliar backlog, then autofix-on once the operator has seen the escalation surface.

### Step 2: Launch the Workflow

Invoke the **Workflow** tool with `scriptPath` pointing at this skill's `workflow.js` and `args`:

```json
{
  "repo": "<owner>/<repo>",
  "defaultBranch": "main",
  "umbrella": 989,
  "only": null,
  "autofix": true
}
```

- `repo` is required; `defaultBranch` defaults to `main`.
- Set at most one of `umbrella` / `only`; omit both for the whole backlog.
- `autofix` defaults to `true`; set `false` to classify + close only.

The Workflow runs headless in the background; you are notified on completion. Do not poll. It performs, in order:

1. **Discover** — list in-scope open `review-residual` issues; map each to its tracked sub-issue (from the `Relates to #<n>` line) and read its labels to classify a `human_state`: `fresh`, `needs-input` (parked, awaiting the operator — skipped this run), or `go` (operator answered — triaged in consume mode).
2. **Triage** — one subagent per `fresh`/`go` residual, in parallel: re-judge each finding against the shipped diff + current files, post a triage comment, and close the residual if nothing actionable remains. A residual whose sub-issue hasn't shipped is left open and marked deferred. For `go` residuals it runs in **consume mode**: it reads the operator's `**Answer:**` lines under the `## Decision needed` block and re-classifies accordingly (accept → resolved; "do X" → a high-confidence fix).
3. **Autofix** (if enabled) — over a now-quiescent default branch, each residual with a high-confidence `FIX_NOW` finding gets one PR (implementing only those fixes) serial-merged through the standard merge-safety contract. The PR `Closes` the residual when its fixes resolve everything actionable, else `Relates to` it.
4. **Park** — each shipped residual with a remaining judgment call (`DECISION` or low-confidence `FIX_NOW`) gets a `## Decision needed` block written into its body — the question, your recommended answer, and the alternatives — and the `review-residual:needs-input` label. This is the durable record the operator drains (see Step 3 below and `/cw-resolve`).

### Step 3: Surface the report

The Workflow returns:

```json
{
  "repo": "<owner>/<repo>",
  "triaged": [{ "residual_issue": 1000, "sub_issue": 986, "shipped": true, "closed": true, "disposition": "close-now" }],
  "autofixed": [{ "residual_issue": 992, "pr": "https://github.com/.../pull/NNN", "merged": true, "cause": null }],
  "parked": [1010],
  "escalations": [{ "residual_issue": 1010, "sub_issue": 984, "title": "...", "verdict": "DECISION", "confidence": null, "rationale": "...", "decision_question": "Should the banner repeat each run?", "recommended_answer": "Show once per session", "alt_options": ["Always show", "Never show"] }],
  "awaiting_input": [1004],
  "deferred_residuals": [1011]
}
```

**If you are in an interactive session and `escalations` is non-empty, ask the decisions immediately — do not dump them as prose.** This is the same recommendation-first flow as `/cw-resolve` (the Workflow already parked them durably, so this just drains them now):

1. For each escalation, in `residual_issue` order, restate the residual in one line for context (e.g. "_#1010 (feature #984): is the banner meant to repeat each run?_").
2. Ask via `AskUserQuestion`, one decision per turn: the `decision_question` as the prompt, `recommended_answer` as the first option marked "(Recommended)", then `alt_options`. Always include a **skip** path — if the operator isn't ready, leave the residual `review-residual:needs-input` and move on.
3. Write the answer back into the residual body (the `## Decision needed` block) as an `**Answer:** <decision>` line, then advance the label: an accept/no-change answer → close the residual; a "do X" answer → `--add-label review-residual:go --remove-label review-residual:needs-input` so the next sweep applies it. Use `gh issue view … --json body -q .body > body.md` → edit → `gh issue edit … --body-file body.md` (never hand-escape). After clearing a batch, offer to re-run `/cw-sweep` on the `:go` set to apply the answered fixes now.

In a **headless/scheduled run** (you were told to run non-interactively) do **not** answer decisions yourself — the Park step already recorded them as `review-residual:needs-input` for the operator to drain later via `/cw-resolve`. Just report.

Then surface the rest for the operator:

- **`escalations`** — the decisions (now asked inline if interactive, else parked): each with its residual link, the question, and the recommended answer.
- **`awaiting_input`** — residuals parked in a prior run still waiting on the operator; nothing this run touched. Point the operator at `/cw-resolve` to drain them.
- **`deferred_residuals`** — residuals whose feature hasn't shipped; nothing to do now, re-run after it merges.

Then summarize what was cleared: how many residuals closed (`triaged` where `closed: true`), how many fixes merged (`autofixed` where `merged: true`), and how many were parked. A clean backlog run should leave behind only decisions, awaiting-input, and deferrals.

### Step 4: Reconcile the umbrella (mandatory when scoped to one)

If the run was scoped to an umbrella (`umbrella` arg set), or every triaged residual traces back to a single umbrella, **update that umbrella issue before declaring done** — a residual run that closes issues but leaves the umbrella stale is not finished. The umbrella body is hand-curated prose, so reconcile it with judgment rather than a blind rewrite:

1. **Check off and rewrite stale lines.** For every residual or sub-issue this run closed (including via an autofix PR), flip its checkbox to `[x]` and update any status/prose line that still calls it "open" or "awaiting the residual-triage skill." Fetch the body with `gh issue view <umbrella> --json body -q .body > body.md`, edit surgically, and push with `gh issue edit <umbrella> --body-file body.md`. Preserve everything you did not change verbatim.
2. **Record new deferrals.** If the run split work out into a new follow-up issue (e.g. a deferred test), add it to the umbrella's deferred list so it is tracked.
3. **Post a reconciliation comment.** Add a short `gh issue comment <umbrella>` summarizing the run: residuals closed (resolved/moot vs. via which PRs), escalations still open, and deferrals. This is the additive audit trail; the body edits are the live state.
4. **Verify.** Re-read the body and confirm the only remaining `- [ ]` items are genuine deferrals or not-yet-shipped work. Quote the remaining unchecked items back to the operator.

Apply the same standing rule to any **other** issue a merged autofix PR closed: check it off and update its description to match what shipped.

### Step 5: Clean up the run's worktrees and heal the default branch

This step *heals* the primary checkout; the invariant that keeps it healable — all work in worktrees, never a commit on the primary checkout — and the enforcing `pre-commit` hook are in [cw-orchestrate's worktree-discipline.md](../cw-orchestrate/references/worktree-discipline.md).

After the report (and any umbrella reconciliation), remove the debris the background Workflow leaves behind. The `autofix` subagents run with `isolation: 'worktree'`, so each leaves a `wf_<workflowRunId>-NN` worktree **and** a local feature branch. The serialized merge step's `gh pr merge --delete-branch` deletes the **remote** branch but leaves the local worktree and branch; and because `gh` runs from inside a worktree, its post-merge local cleanup often fails noisily and can leave the default-branch checkout switched onto a feature branch with local `<defaultBranch>` sitting behind the squash commits — that is what makes a later `git pull` report divergent branches. Heal all of this automatically, **scoped strictly to this run's artifacts**:

1. **Capture the `workflowRunId`** the Workflow tool returned at launch in Step 2 (e.g. `wf_f589ef2f-d48`). Only worktrees whose path matches `.claude/worktrees/<workflowRunId>-*` are in scope — never other runs' `wf_*` worktrees, never named/human worktrees, never the session's own worktree. (Concurrent `cw-ship`/`cw-sweep`/`cw-orchestrate` runs each scope to their own `workflowRunId`, so they never touch each other's worktrees.)
2. **Remove vs. keep is decided by merge state, never by guesswork.** For each in-scope worktree, read its branch (`git worktree list`), then:
   - **Merged + clean** — its PR is `MERGED` (remote branch gone: `git ls-remote --heads origin <branch>` is empty) **and** `git -C <wt> status --porcelain` is empty → `git worktree unlock <wt> 2>/dev/null; git worktree remove --force <wt>; git branch -D <branch>`. Then also delete the worktree's **auto-created placeholder branch** `worktree-<basename-of-wt>` (verify `git merge-base --is-ancestor worktree-<name> origin/<defaultBranch>` before `git branch -D`).
   - **Stalled or dirty** — the remote branch still exists (an autofix PR left open by a P0 or a not-green merge), or the worktree has uncommitted changes → **keep it untouched** and name it in the cleanup summary.
3. **Heal the default branch.** `git fetch origin <defaultBranch>`. If the primary checkout (or any surviving worktree) is parked on a now-deleted feature branch, switch it back to `<defaultBranch>` (untracked files are preserved across the switch). Then advance local `<defaultBranch>` to `origin/<defaultBranch>`: `git branch -f <defaultBranch> origin/<defaultBranch>` when nothing has it checked out, else `git -C <checkout> merge --ff-only origin/<defaultBranch>`. A local-only commit on `<defaultBranch>` here is the **un-squashed twin** of a commit already on `origin/<defaultBranch>` (a squash-merge artifact), so advancing loses no work — confirm with `git log origin/<defaultBranch>..<defaultBranch>` showing only such twins before forcing.
4. `git worktree prune`, then report what was removed and what was deliberately kept.

The merge-state gate is what makes this safe to run unattended: a worktree is removed only when its work is provably on `<defaultBranch>` and the tree is clean. Never remove a worktree with uncommitted changes or an unmerged branch. With autofix off, no worktrees are created and this step is a no-op.

## Key Notes

- **Triage is against shipped code, never the plan.** A residual filed against a plan is only meaningful once re-checked against the merged diff — half are moot because the implementation already fixed or diverged from the flagged thing. This is why the skill needs the sub-issue's PR to have merged; unshipped residuals defer.
- **The confidence gate is the safety boundary.** Only `FIX_NOW` findings the triage subagent marks high-confidence (correct, safe, in-scope) are auto-applied and merged unsupervised. Anything ambiguous becomes an escalation. Auto-merging a wrong fix is worse than leaving a residual open.
- **Self-cleaning (Step 5).** All fixes are implemented in `isolation: 'worktree'` autofix subagents, never on the default checkout. After the run the main session removes its own `wf_<runId>-*` worktrees and local branches and heals the default-branch checkout — scoped to this run's `workflowRunId` and gated on merge state — so the working copy is left clean on `<defaultBranch>` matching `origin`, even with many concurrent runs.
- **Decisions follow a park/resolve/go loop, mirroring the feedback pipeline.** A genuine judgment call is parked onto its residual (`review-residual:needs-input` + a `## Decision needed` block carrying the recommended answer). The operator answers — inline here in an interactive run, or later via `/cw-resolve` — which sets `review-residual:go`; the next sweep consumes the answer (close, or apply the specified fix). The same `decision_question` / `recommended_answer` / `alt_options` fields drive both the inline `AskUserQuestion` and the parked block, so the recommendation is authored once. Headless runs never answer decisions themselves — they only park.
- **Closing is reversible; merging is not.** The skill closes resolved/moot residuals freely (a human can reopen) but is strict about what code it lands. Mismatched aggressiveness on purpose.
- **Idempotent-ish.** Re-running over the same scope re-triages still-open residuals; already-closed ones drop out of discovery. Safe to run repeatedly as features ship and deferrals become triageable.
- **Git/PR via `gh`/`git`, not MCP.** Background Workflow subagents may not have interactively-authenticated MCP servers.
