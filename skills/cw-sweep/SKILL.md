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

1. **Discover** — list in-scope open `review-residual` issues; map each to its tracked sub-issue (from the `Relates to #<n>` line).
2. **Triage** — one subagent per residual, in parallel: re-judge each finding against the shipped diff + current files, post a triage comment, and close the residual if nothing actionable remains. A residual whose sub-issue hasn't shipped is left open and marked deferred.
3. **Autofix** (if enabled) — over a now-quiescent default branch, each residual with a high-confidence `FIX_NOW` finding gets one PR (implementing only those fixes) serial-merged through the standard merge-safety contract. The PR `Closes` the residual when its fixes resolve everything actionable, else `Relates to` it.

### Step 3: Surface the report

The Workflow returns:

```json
{
  "repo": "<owner>/<repo>",
  "triaged": [{ "residual_issue": 1000, "sub_issue": 986, "shipped": true, "closed": true, "disposition": "close-now" }],
  "autofixed": [{ "residual_issue": 992, "pr": "https://github.com/.../pull/NNN", "merged": true, "cause": null }],
  "escalations": [{ "residual_issue": 1010, "sub_issue": 984, "title": "...", "verdict": "DECISION", "confidence": null, "rationale": "..." }],
  "deferred_residuals": [1010]
}
```

Render it for the operator with the two action items first:

- **`escalations`** — the only thing that needs a decision: genuine judgment calls and fixes the classifier flagged low-confidence. List each with its residual link, the finding, and the rationale so the operator can act or hand it back.
- **`deferred_residuals`** — residuals whose feature hasn't shipped; nothing to do now, re-run after it merges.

Then summarize what was cleared: how many residuals closed (`triaged` where `closed: true`) and how many fixes merged (`autofixed` where `merged: true`). A clean backlog run should leave behind only escalations and deferrals.

### Step 4: Reconcile the umbrella (mandatory when scoped to one)

If the run was scoped to an umbrella (`umbrella` arg set), or every triaged residual traces back to a single umbrella, **update that umbrella issue before declaring done** — a residual run that closes issues but leaves the umbrella stale is not finished. The umbrella body is hand-curated prose, so reconcile it with judgment rather than a blind rewrite:

1. **Check off and rewrite stale lines.** For every residual or sub-issue this run closed (including via an autofix PR), flip its checkbox to `[x]` and update any status/prose line that still calls it "open" or "awaiting the residual-triage skill." Fetch the body with `gh issue view <umbrella> --json body -q .body > body.md`, edit surgically, and push with `gh issue edit <umbrella> --body-file body.md`. Preserve everything you did not change verbatim.
2. **Record new deferrals.** If the run split work out into a new follow-up issue (e.g. a deferred test), add it to the umbrella's deferred list so it is tracked.
3. **Post a reconciliation comment.** Add a short `gh issue comment <umbrella>` summarizing the run: residuals closed (resolved/moot vs. via which PRs), escalations still open, and deferrals. This is the additive audit trail; the body edits are the live state.
4. **Verify.** Re-read the body and confirm the only remaining `- [ ]` items are genuine deferrals or not-yet-shipped work. Quote the remaining unchecked items back to the operator.

Apply the same standing rule to any **other** issue a merged autofix PR closed: check it off and update its description to match what shipped.

## Key Notes

- **Triage is against shipped code, never the plan.** A residual filed against a plan is only meaningful once re-checked against the merged diff — half are moot because the implementation already fixed or diverged from the flagged thing. This is why the skill needs the sub-issue's PR to have merged; unshipped residuals defer.
- **The confidence gate is the safety boundary.** Only `FIX_NOW` findings the triage subagent marks high-confidence (correct, safe, in-scope) are auto-applied and merged unsupervised. Anything ambiguous becomes an escalation. Auto-merging a wrong fix is worse than leaving a residual open.
- **Closing is reversible; merging is not.** The skill closes resolved/moot residuals freely (a human can reopen) but is strict about what code it lands. Mismatched aggressiveness on purpose.
- **Idempotent-ish.** Re-running over the same scope re-triages still-open residuals; already-closed ones drop out of discovery. Safe to run repeatedly as features ship and deferrals become triageable.
- **Git/PR via `gh`/`git`, not MCP.** Background Workflow subagents may not have interactively-authenticated MCP servers.
