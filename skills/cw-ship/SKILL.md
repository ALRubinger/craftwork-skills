---
name: cw-ship
description: Drain the backlog of dogfooding-feedback issues filed by /cw-feedback. Per issue, plan the change against the actual code, then either autonomously build + squash-merge a single PR (small/medium, intent clear), park genuine design forks back to the issue body for the operator (feedback:needs-input), or file a ready umbrella + hand it to cw-orchestrate (large, operator-cleared). Built to run unattended on a schedule. Trigger when the user wants to process, triage, or act on feedback issues.
metadata:
  version: "0.1.0"
  triggers:
    - triage.?(the)?.?feedback
    - (process|drain|clear|work).?(the)?.?feedback.?(backlog|issues|queue)
    - act.?on.?(the)?.?feedback
    - run.?(the)?.?feedback.?loop
---

# cw-ship

Turn captured feedback into merged changes. This is the **back-end** to [`cw-feedback`](../cw-feedback/SKILL.md): `cw-feedback` records an observation as a `feedback:new` issue; this skill plans it against the code and resolves it — autonomously when it can, with the operator only when a real decision is needed.

The two skills share one issue and a label state machine, documented in [references/state-machine.md](./references/state-machine.md). That document is the contract; read it before changing either skill.

Per in-scope issue, the loop routes to exactly one outcome:

- **Build** (small/medium, intent clear after research) → branch → PR with `Closes #<issue>` → serialized squash-merge. Fully hands-off; the operator never sees it.
- **Park** (a genuine design fork remains, or the change is umbrella-sized but not yet cleared) → write the open questions / proposed scope into the **issue body**, flip to `feedback:needs-input`, stop. The operator answers inline and adds `feedback:go`; the next run resumes it autonomously.
- **Umbrella** (umbrella-sized AND the operator already added `feedback:go`) → file a ready umbrella + sub-issues, link and close the feedback issue, then hand execution to [`cw-orchestrate`](../cw-orchestrate/SKILL.md).

The design mirror is deliberate: this is to `cw-orchestrate` what a self-driving triage is to a manual one. The blocking point is the same — *once you say go, it's autonomous to merge.* The only thing that stops the loop is a decision your original feedback didn't settle, and that stop is async: it lands in the issue body for you to answer whenever.

## When to Use

On a schedule (the default — see [references/scheduling.md](./references/scheduling.md)) or on demand to process the feedback backlog: "triage the feedback issues", "run the feedback loop", "act on the feedback for <owner>/<repo>". Do **not** use it to capture new feedback (that's `/cw-feedback`) or to execute an existing umbrella (that's `/cw-orchestrate`).

## Prerequisites

- `gh` (authenticated — `gh auth status`) and `git`.
- The **Workflow** tool. The skill launches `workflow.js` via `scriptPath`.
- Standing PR-shepherd authorization for this repo family (squash-merge with `--admin`, `--force-with-lease` rebase) — the build path merges unsupervised.
- A run lock so scheduled runs don't overlap (Step 1).

## Workflow

### Step 0: Load repository instructions

Find `AGENTS.md` / `CLAUDE.md` in the target repo and note its build/test/merge conventions (spec-is-source-of-truth + regen, conventional commits, squash + `--admin`, coverage bar, docs voice, no backwards-compat) and the default branch. The build subagents must honor them; they're passed the repo and re-read these themselves, but you confirm the repo and default branch here.

### Step 1: Hold the run lock

This skill is built to run unattended and overlapping runs could double-process an issue. Take a coarse run lock before launching (the per-issue `feedback:triaging` label is a second, finer guard the Workflow manages):

```sh
LOCK="$HOME/.cache/cw-ship/<owner>-<repo>.lock"
mkdir -p "$(dirname "$LOCK")"
# acquire atomically; if held by a live run, exit cleanly
if ! ( set -o noclobber; echo "$$ $(date -u +%FT%TZ)" > "$LOCK" ) 2>/dev/null; then
  echo "another cw-ship run holds the lock; exiting"; exit 0
fi
trap 'rm -f "$LOCK"' EXIT
```

A stale lock older than ~1h with no live owner can be removed by hand; the next run proceeds.

### Step 2: Launch the Workflow

Invoke the **Workflow** tool with `scriptPath` pointing at this skill's `workflow.js` and `args`:

```json
{
  "repo": "<owner>/<repo>",
  "defaultBranch": "main",
  "only": null,
  "build": true
}
```

- `repo` is required; `defaultBranch` defaults to `main`.
- `only` — optional array of specific feedback issue numbers; omit for the whole `feedback:new` / `feedback:go` backlog.
- `build` defaults to `true`; set `false` for a **dry triage** — plan + park + file umbrellas, but open no PRs. Recommended for a first run on an unfamiliar backlog, then `build: true` once you've seen what it routes.

The Workflow runs headless in the background; you are notified on completion. Do not poll. It performs, in order:

1. **Discover** — union of open `feedback:new` and `feedback:go` issues, minus any already `feedback:triaging`.
2. **Plan** — one subagent per issue, in parallel: lock the issue (`feedback:triaging`), read intent, research against the code, and route `fix` / `needs-input` / `umbrella`. A `feedback:go` issue carries the operator's inline answers — the planner treats those forks as settled.
3. **Resolve** — park the question/scope issues to the body (`feedback:needs-input`); file umbrellas for cleared umbrella-sized issues; build + serial-merge the small ones over a quiescent default branch.

### Step 3: Hand filed umbrellas to cw-orchestrate

The Workflow returns `umbrellas_filed: [{ feedback_issue, umbrella, url, sub_issues }]`. For each, execute it autonomously by running `/cw-orchestrate <umbrella>` — that skill runs its readiness sweep and drives the sub-issues to merged PRs hands-off. (The Workflow deliberately does **not** invoke orchestrate inline: orchestrate needs a manifest from its own sweep, and nesting a multi-hour run inside this one would unbound a scheduled tick.) In a headless cron run, chain this as a second wrapper step (see scheduling.md); orchestrate is idempotent, so a separately-scheduled orchestrate run also picks the umbrella up.

### Step 4: Surface the report

The Workflow returns:

```json
{
  "repo": "<owner>/<repo>",
  "planned": [{ "issue": 130, "route": "fix", "disposition": "build" }],
  "built": [{ "issue": 130, "pr": "https://github.com/.../pull/NNN", "merged": true, "cause": null }],
  "umbrellas_filed": [{ "feedback_issue": 141, "umbrella": 142, "url": "...", "sub_issues": [143, 144] }],
  "escalations": [{ "issue": 137, "url": "...", "reason": "open-questions", "questions": ["..."] }]
}
```

Render it with the action item first:

- **`escalations`** — the only thing that needs you: each parked issue, why it parked (`open-questions` or `umbrella-scope`), and the questions now in its body. To unblock, run `/cw-resolve` — it walks you through every parked question and flips them to `feedback:go`. Surface these prominently; everything else was handled.
- Then summarize what landed: feedback issues merged (`built` where `merged: true`), umbrellas filed (now executing via orchestrate), and anything stalled (`built` where `merged: false`, with cause).

### Step 4.5: Nudge if anything parked

If `escalations` is non-empty, fire **one** `PushNotification` so the operator knows there's input waiting — this is the trigger that tells them to run `/cw-resolve`. Without it, a parked issue could sit unnoticed until they happen to look. Keep it one line, lead with the count and the action:

> `N feedback issue(s) need your input — run /cw-resolve to clear them. (#137 launch banner, #140 …)`

Send it only when `escalations.length > 0`; a run that merged everything and parked nothing should stay silent (a no-op notification is the kind that trains the operator to ignore them). Name the first issue or two for context, but don't dump the whole list — the inbox skill is where they'll see it all. In a headless cron run this still fires: `claude -p` has the `PushNotification` tool, and with Remote Control connected it reaches the phone.

### Step 5: Reconcile the issues this run touched (GitHub is the source of truth)

GitHub must reflect what actually shipped before the run ends — reconcile every issue it touched per the [issue-reconciliation contract](../cw-orchestrate/references/issue-reconciliation.md). The build path's only built-in reconciliation is the PR's `Closes #<issue>` keyword auto-closing the one feedback issue; a missing keyword, a parent that tracks the issue, cross-references, or a description that no longer matches what shipped are all on this step. For each entry in the report's `built` list with `merged: true`:

1. **Confirm the feedback issue actually closed; close it if not.** `gh issue view <issue> --json state`. A merged PR whose body carried `Closes #<issue>` auto-closed it; if it is still `OPEN` (the keyword was omitted), close it: `gh issue close <issue> --comment "Shipped via PR #<pr>. <one line>"`. Never close an issue whose PR is `merged: false` (stalled) — leave it open with its cause.
2. **Update the feedback issue's description if the change diverged from the captured intent.** When what shipped differs from the "What I want changed" the feedback recorded (different approach, narrower/broader scope, follow-ups split into new issues), edit the body so it reads true (contract rule 4); otherwise the closing comment is enough.
3. **Reconcile anything that tracks or references it** (contract rules 2–3, 5). If the feedback issue appears in a parent/tracking/milestone checklist, tick its line `- [x]`, and close that parent if this was its last open child and nothing else is deferred/stalled. Reconcile any issue the feedback body or the PR `Relates to`/mentions: tick/close/annotate as its state now warrants, or post a one-line "addressed by PR #<pr>". Most dogfooding-feedback issues are standalone, so this is often a no-op — do it only when there is a real reference.
4. **Verify.** Re-read the closed issues and any tracker you edited to confirm the edits landed.

For umbrellas this run filed (Step 3), reconciling their sub-issues is `cw-orchestrate`'s Step 7 — don't duplicate it here. This step runs **before** the worktree cleanup (Step 6): GitHub truth first, local tidiness second.

### Step 6: Clean up the run's worktrees and heal the default branch

This step *heals* the primary checkout; the invariant that keeps it healable — all work in worktrees, never a commit on the primary checkout — and the enforcing `pre-commit` hook are in [cw-orchestrate's worktree-discipline.md](../cw-orchestrate/references/worktree-discipline.md).

After the report is surfaced (and before releasing the lock), remove the debris the background Workflow leaves behind. The `build` subagents run with `isolation: 'worktree'`, so each leaves a `wf_<workflowRunId>-NN` worktree **and** a local feature branch. The serialized merge step's `gh pr merge --delete-branch` deletes the **remote** branch but leaves the local worktree and branch; and because `gh` runs from inside a worktree, its post-merge local cleanup often fails noisily and can leave the default-branch checkout switched onto a feature branch with local `<defaultBranch>` sitting behind the squash commits — that is what makes a later `git pull` report divergent branches. Heal all of this automatically, **scoped strictly to this run's artifacts**:

1. **Capture the `workflowRunId`** the Workflow tool returned at launch in Step 2 (e.g. `wf_f589ef2f-d48`). Only worktrees whose path matches `.claude/worktrees/<workflowRunId>-*` are in scope — never other runs' `wf_*` worktrees, never named/human worktrees, never the session's own worktree. (Concurrent `cw-ship`/`cw-sweep`/`cw-orchestrate` runs each scope to their own `workflowRunId`, so they never touch each other's worktrees.)
2. **Remove vs. keep is decided by merge state, never by guesswork.** For each in-scope worktree, read its branch (`git worktree list`), then:
   - **Merged + clean** — its PR is `MERGED` (remote branch gone: `git ls-remote --heads origin <branch>` is empty) **and** `git -C <wt> status --porcelain` is empty → `git worktree unlock <wt> 2>/dev/null; git worktree remove --force <wt>; git branch -D <branch>`. Then also delete the worktree's **auto-created placeholder branch** `worktree-<basename-of-wt>` (verify `git merge-base --is-ancestor worktree-<name> origin/<defaultBranch>` before `git branch -D`).
   - **Stalled or dirty** — the remote branch still exists (a build that hit a mid-flight fork and left an open PR), or the worktree has uncommitted changes → **keep it untouched** and name it in the cleanup summary.
3. **Heal the default branch.** `git fetch origin <defaultBranch>`. If the primary checkout (or any surviving worktree) is parked on a now-deleted feature branch, switch it back to `<defaultBranch>` (untracked files are preserved across the switch). Then advance local `<defaultBranch>` to `origin/<defaultBranch>`: `git branch -f <defaultBranch> origin/<defaultBranch>` when nothing has it checked out, else `git -C <checkout> merge --ff-only origin/<defaultBranch>`. A local-only commit on `<defaultBranch>` here is the **un-squashed twin** of a commit already on `origin/<defaultBranch>` (a squash-merge artifact), so advancing loses no work — confirm with `git log origin/<defaultBranch>..<defaultBranch>` showing only such twins before forcing.
4. `git worktree prune`, then report what was removed and what was deliberately kept.

The merge-state gate is what makes this safe to run unattended: a worktree is removed only when its work is provably on `<defaultBranch>` and the tree is clean. Never remove a worktree with uncommitted changes or an unmerged branch.

### Step 7: Release the lock

The `trap` in Step 1 removes the lock on exit. If you launched the Workflow and returned, the lock should be released once the run is fully reported and the cleanup in Step 6 is done (the background Workflow does its own gh work; the lock guards against a *second skill invocation* overlapping, which the label guard also covers).

## Key Notes

- **The blocking point is a design fork, nothing else.** The loop only stops for a decision your feedback didn't settle. It does not stop to let you review PRs — that's the whole point. If you find yourself wanting to review the small ones, that's a signal to start with `build: false` until you trust the routing, not to add a review gate.
- **Clearing parks is one action: run `/cw-resolve`.** It finds every `feedback:needs-input` issue, walks you through the questions (recommended answer pre-filled), writes your answers into the body, and adds `feedback:go`. A park-time push notification tells you when there's something to clear. The loop never resumes a parked issue without `feedback:go` and never re-asks an answered question.
- **Build conservatism mirrors cw-sweep.** A subagent that hits an unsettled fork mid-build reports `needs-input: <question>` rather than guessing; that issue parks back to you instead of merging a wrong call. Auto-merging a wrong change is worse than parking.
- **GitHub is the source of truth (Step 5).** A merged change isn't done until GitHub reflects it: the feedback issue closed (the `Closes` keyword usually does this, but a missing keyword is closed as a safety net), its description updated if the change diverged from the captured intent, and any parent/tracker/cross-reference reconciled. Standalone feedback issues make this a near no-op; issues tracked by a parent or referencing others get the same close/tick/update as cw-orchestrate's Step 7. The shared contract is [issue-reconciliation.md](../cw-orchestrate/references/issue-reconciliation.md).
- **Self-cleaning (Step 6).** All implementation happens in `isolation: 'worktree'` build subagents, never on the default checkout. After the run the main session removes its own `wf_<runId>-*` worktrees and local branches and heals the default-branch checkout — scoped to this run's `workflowRunId` and gated on merge state — so the working copy is left clean on `<defaultBranch>` matching `origin`. This is what keeps many concurrent runs from leaving the shared checkout parked on a feature branch with a divergent local `<defaultBranch>`.
- **Idempotent + locked.** Every run re-discovers from live labels, so a missed/partial/crashed run self-heals next tick. The run lock + `feedback:triaging` label prevent double-processing.
- **Umbrella handoff uses the existing seam.** This skill files a *ready* umbrella and lets `cw-orchestrate` execute it — it does not reimplement orchestration. The operator's `feedback:go` on an umbrella-sized issue is the approval that authorizes both filing and execution.
- **Git/PR via `gh`/`git`, not MCP** — background Workflow subagents may not have interactively-authenticated MCP servers.
