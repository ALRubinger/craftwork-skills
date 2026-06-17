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

On a schedule (the default — see [references/scheduling.md](./references/scheduling.md)) or on demand to process the feedback backlog: "triage the feedback issues", "run the feedback loop", "act on the feedback for ALRubinger/aileron". Do **not** use it to capture new feedback (that's `/cw-feedback`) or to execute an existing umbrella (that's `/cw-orchestrate`).

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
  "repo": "ALRubinger/aileron",
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
  "repo": "ALRubinger/aileron",
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

### Step 5: Release the lock

The `trap` in Step 1 removes the lock on exit. If you launched the Workflow and returned, the lock should be released once the run is fully reported (the background Workflow does its own gh work; the lock guards against a *second skill invocation* overlapping, which the label guard also covers).

## Key Notes

- **The blocking point is a design fork, nothing else.** The loop only stops for a decision your feedback didn't settle. It does not stop to let you review PRs — that's the whole point. If you find yourself wanting to review the small ones, that's a signal to start with `build: false` until you trust the routing, not to add a review gate.
- **Clearing parks is one action: run `/cw-resolve`.** It finds every `feedback:needs-input` issue, walks you through the questions (recommended answer pre-filled), writes your answers into the body, and adds `feedback:go`. A park-time push notification tells you when there's something to clear. The loop never resumes a parked issue without `feedback:go` and never re-asks an answered question.
- **Build conservatism mirrors cw-sweep.** A subagent that hits an unsettled fork mid-build reports `needs-input: <question>` rather than guessing; that issue parks back to you instead of merging a wrong call. Auto-merging a wrong change is worse than parking.
- **Idempotent + locked.** Every run re-discovers from live labels, so a missed/partial/crashed run self-heals next tick. The run lock + `feedback:triaging` label prevent double-processing.
- **Umbrella handoff uses the existing seam.** This skill files a *ready* umbrella and lets `cw-orchestrate` execute it — it does not reimplement orchestration. The operator's `feedback:go` on an umbrella-sized issue is the approval that authorizes both filing and execution.
- **Git/PR via `gh`/`git`, not MCP** — background Workflow subagents may not have interactively-authenticated MCP servers.
