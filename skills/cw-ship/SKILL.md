---
name: cw-ship
description: Drain the backlog of dogfooding-feedback issues filed by the cw-feedback skill. Per issue, plan the change against the actual code, then either autonomously build + squash-merge a single PR (small/medium, intent clear), park genuine design forks back to the issue body for the operator (cw-feedback:needs-input), or — when the change is umbrella-sized and its intent is clear — file a ready umbrella + hand it straight to cw-orchestrate with no approval step. Supports any Agent Skills harness through compatible workflow execution, native subagent fanout, or portable foreground execution. Trigger when the user wants to process, triage, or act on feedback issues.
metadata:
  version: "0.1.0"
  triggers:
    - triage.?(the)?.?feedback
    - (process|drain|clear|work).?(the)?.?feedback.?(backlog|issues|queue)
    - act.?on.?(the)?.?feedback
    - run.?(the)?.?feedback.?loop
---

# cw-ship

Turn captured feedback into merged changes. This is the **back-end** to [`cw-feedback`](../cw-feedback/SKILL.md): `cw-feedback` records an observation as a `cw-feedback:new` issue; this skill plans it against the code and resolves it — autonomously when it can, with the operator only when a real decision is needed.

The two skills share one issue and a label state machine, documented in [references/state-machine.md](./references/state-machine.md). That document is the contract; read it before changing either skill.

Per in-scope issue, the loop routes to exactly one outcome:

- **Build** (small/medium, intent clear after research) → branch → PR with `Closes #<issue>` → serialized squash-merge. Fully hands-off; the operator never sees it.
- **Park** (a genuine design fork remains) → write the open questions into the **issue body**, flip to `cw-feedback:needs-input`, stop. The operator answers inline and adds `cw-feedback:go`; the next run resumes it autonomously. Being umbrella-sized is **not** itself a reason to park — only an unsettled design decision is.
- **Umbrella** (umbrella-sized AND intent clear) → file a ready umbrella + sub-issues, link and close the feedback issue, then hand execution straight to [`cw-orchestrate`](../cw-orchestrate/SKILL.md). No approval step and no `cw-feedback:go` gate: if triage can scope it correctly, it files and orchestrates autonomously.

The design mirror is deliberate: this is to `cw-orchestrate` what a self-driving triage is to a manual one. The only thing that stops the loop is a decision your original feedback didn't settle, and that stop is async: it lands in the issue body for you to answer whenever. Everything else — including scoping an umbrella and kicking off its orchestration — runs without a checkpoint.

## When to Use

On demand, when you want to process the feedback backlog: "triage the feedback issues", "run the feedback loop", "act on the feedback for <owner>/<repo>". This is an invoke-it-when-you-want tool, not a background loop; if you nonetheless want to put it on a timer, scheduling is an optional opt-in (see [references/scheduling.md](./references/scheduling.md)). Do **not** use it to capture new feedback (that's the `cw-feedback` skill) or to execute an existing umbrella (that's the `cw-orchestrate` skill).

## Prerequisites

- `gh` (authenticated — `gh auth status`) and `git`.
- A compatible **Workflow** tool if the harness provides one. Otherwise use portable foreground mode; see [agent-harness-portability.md](../cw-orchestrate/references/harness-portability.md).
- Standing PR-shepherd authorization for this repo family (squash-merge with `--admin`, `--force-with-lease` rebase) — the build path merges unsupervised.
- Nothing to lock: cw-ship runs are safe to overlap on the same repo. Concurrency is serialized **per issue** by an atomic claim, not by a repo-wide lock (Step 1).

## Workflow

### Step 0: Load repository instructions

Find `AGENTS.md` / `CLAUDE.md` in the target repo and note its build/test/merge conventions (spec-is-source-of-truth + regen, conventional commits, squash + `--admin`, coverage bar, docs voice, no backwards-compat) and the default branch. The build subagents must honor them; they're passed the repo and re-read these themselves, but you confirm the repo and default branch here.

### Step 1: Concurrency — there is no run lock

**Launch directly; do not take any lock.** N cw-ship runs may execute on the same repo at once. The serialization unit is the **issue**, not the repo: a run builds an issue only if it owns that issue's atomic claim. This replaces the old per-repo lockfile, which was unsound here — every Bash call in this harness is a fresh ephemeral shell, so a PID written into a lock is dead almost immediately and a liveness check can't tell a live run from a finished one (it led to one run "reclaiming" another's lock as stale and double-processing). Nothing about the new model depends on a process being alive.

The Workflow handles the claim per issue (Plan stage):

- **Claim + verify.** A run claims an issue by posting an atomic claim comment (`<!-- cw-ship/claim -->`, identified by GitHub's server-assigned comment id + `created_at`), adds `cw-feedback:triaging`, then re-reads all claim comments and confirms it is the owner — **earliest `created_at` among non-stale claims, ties broken by lowest comment id**. The loser of a race yields (deletes its own claim, leaves the label for the owner) and never builds the issue.
- **Discovery excludes live claims; reclaims crashed ones.** Discovery surfaces `cw-feedback:new` / `cw-feedback:go`, plus a `cw-feedback:triaging` issue **only** if its claim has crashed: older than **`CLAIM_TIMEOUT` (2h)** with no open PR and no recent issue update. A live in-flight claim is never disturbed; a genuinely crashed run's issue is recoverable by age, not by a PID.

The full claim/recovery contract is the load-bearing part of this skill — see [references/state-machine.md](./references/state-machine.md). The pure resolution logic is in `claim.mjs` (tested in `tests/claim.test.mjs`); `planPrompt` in `workflow.js` implements it via gh.

### Step 2: Launch the Workflow, or run the portable foreground path

If the current agent harness can run the bundled Workflow API, invoke the **Workflow** tool with `scriptPath` pointing at this skill's `workflow.js` and `args`:

```json
{
  "repo": "<owner>/<repo>",
  "defaultBranch": "main",
  "only": null,
  "build": true
}
```

- `repo` is required; `defaultBranch` defaults to `main`.
- `only` — optional array of specific feedback issue numbers; omit for the whole `cw-feedback:new` / `cw-feedback:go` backlog.
- `build` defaults to `true`; set `false` for a **dry triage** — plan + park, but open no PRs **and file no umbrellas** (it reports the umbrella disposition and launches no orchestrate). A dry run stays fully dry: it never changes GitHub beyond parking questions. Recommended for a first run on an unfamiliar backlog, then `build: true` once you've seen what it routes — this is the escape hatch for the now-approval-free umbrella path.

If the harness has no compatible Workflow API, do **not** try to execute `workflow.js` with Node. Run portable foreground mode from [agent-harness-portability.md](../cw-orchestrate/references/harness-portability.md): perform the same discover → plan → resolve phases in this session, using harness-native subagents when available or doing the roles locally. In Codex or any harness whose subagent tool requires explicit delegation permission, the user's direct request to run `cw-ship` is that permission: subagent fanout is part of the skill's documented behavior, so do not stop for a second "may I spawn agents?" prompt. Preserve the same report shape and all labels/body transitions below. The run may be foreground and less parallel, but it must keep the same safety gates.

In Workflow mode, the Workflow runs headless in the background; you are notified on completion. In native-subagent foreground mode (for example Codex without a Workflow API), the main session is the controller: it discovers issues, spawns one native planner per issue, dispatches build/park/umbrella workers as each plan lands, serializes merges itself, and performs reconciliation + cleanup. In local-only foreground mode, keep the same phases in this session without parallel agents. Discovery runs first; then every issue flows through plan → resolve **as a streaming pipeline when the harness supports it** — each issue routes onward the moment *its own* plan lands, without waiting for the slowest plan in the batch:

1. **Discover** — union of open `cw-feedback:new` and `cw-feedback:go` issues, plus any `cw-feedback:triaging` issue whose claim has **crashed** (reclaim). A `cw-feedback:triaging` issue with a still-**live** claim is not built; it is surfaced separately as `claimed_elsewhere` (Step 4) rather than silently dropped.
2. **Plan** — one subagent per issue: lock the issue (`cw-feedback:triaging`), read intent, research against the code, and route `fix` / `needs-input` / `umbrella`. The planner routes `umbrella` only when it can scope the work correctly itself; if a genuine design fork still shapes the breakdown it routes `needs-input` instead (which parks) — umbrella-ness alone never parks. A `cw-feedback:go` issue carries the operator's inline answers — the planner treats those forks as settled. Plans run concurrently, and each feeds straight into resolve as it completes (no plan barrier).
3. **Resolve** — dispatched per issue by its plan's route: park the design-fork issues to the body (`cw-feedback:needs-input`); file umbrellas for umbrella-sized issues (no `cw-feedback:go` gate); **build the small ones**. Builds **fan out in parallel** (each in its own isolated worktree), but the **merge step is serialized** — one PR touches the default branch at a time, because the merge agent rebases against the *live* branch and concurrent merges would race. Two issues that touch the same code both build off the base and the later one rebases at merge: the serial-merge step re-checks every PR against the live default branch and, on a same-base conflict against a sibling that just landed, **rebases and resolves the hunks honoring both sides, re-runs the full build + test suite as the gate, and merges only if green** — an unresolvable conflict or a failing re-run stalls the issue for the operator instead of force-resolving. (The merge gate is the correctness backstop; there is no pre-build collision scheduler — overlap is handled at merge time.)

### Step 3: Hand filed umbrellas to cw-orchestrate

The Workflow returns `umbrellas_filed: [{ feedback_issue, umbrella, url, sub_issues }]`. For each, execute it autonomously by running `cw-orchestrate` number mode for `<umbrella>` — **without asking the operator first.** Do not pause to confirm whether to orchestrate: a filed umbrella is one triage already judged ready, so kicking off its orchestration is part of the same hands-off action. That skill runs its readiness sweep and drives the sub-issues to merged PRs hands-off. (The Workflow deliberately does **not** invoke orchestrate inline: orchestrate needs a manifest from its own sweep, and nesting a multi-hour run inside this one would unbound a scheduled tick — so the launch happens here, in the main session, not as a gate.) In a headless cron run, chain this as a second wrapper step (see scheduling.md); orchestrate is idempotent and keys off the umbrella's `cw-umbrella:ready` label, so a separately-scheduled orchestrate run also picks the umbrella up — no checkpoint on either path.

### Step 4: Surface the report

The Workflow returns:

```json
{
  "repo": "<owner>/<repo>",
  "planned": [{ "issue": 130, "route": "fix", "disposition": "build" }],
  "built": [{ "issue": 130, "pr": "https://github.com/.../pull/NNN", "merged": true, "cause": null }],
  "umbrellas_filed": [{ "feedback_issue": 141, "umbrella": 142, "url": "...", "sub_issues": [143, 144] }],
  "escalations": [{ "issue": 137, "url": "...", "reason": "open-questions", "questions": ["..."] }],
  "claimed_elsewhere": [{ "issue": 138, "url": "...", "last_activity": "...", "claim_age": "12m", "reclaim_at": "..." }]
}
```

Render it with the action item first:

- **`escalations`** — the only thing that needs you: each parked issue parked for the one remaining reason (`open-questions` — a genuine design fork), with the questions now in its body. To unblock, run the `cw-resolve` skill — it walks you through every parked question and flips them to `cw-feedback:go`. Surface these prominently; everything else was handled.
- **`claimed_elsewhere`** — issues in scope but **held by another still-live run's claim**; this run did not touch them. Render it as its own section, distinct from `escalations` and from an empty backlog: *"#138 is held by another run, auto-reclaims at `<reclaim_at>` if that run is dead."* This is **not** an action item — do **not** manually reset `cw-feedback:triaging -> cw-feedback:new` to "unstick" it, which races a possibly-live run. The loop auto-reclaims a genuinely dead claim at `reclaim_at` (claim age past `CLAIM_TIMEOUT`, no open PR, no recent activity); wait for that tick. A non-empty `claimed_elsewhere` with an otherwise-empty result means "another run owns this," not "nothing to do."
- Then summarize what landed: feedback issues merged (`built` where `merged: true`), umbrellas filed (now executing via orchestrate), and anything stalled (`built` where `merged: false`, with cause).

### Step 4.5: Nudge if anything parked

If `escalations` is non-empty and the harness provides a push-notification capability, fire **one** notification so the operator knows there's input waiting — this is the trigger that tells them to run the `cw-resolve` skill. Without that capability, make the final report's first action item the parked-decision count and rely on the issue labels/body as the durable notification. Keep it one line, lead with the count and the action:

> `N feedback issue(s) need your input — invoke the cw-resolve skill to clear them. (#137 launch banner, #140 …)`

Send it only when `escalations.length > 0`; a run that merged everything and parked nothing should stay silent. Name the first issue or two for context, but don't dump the whole list — the inbox skill is where they'll see it all. In harnesses without push notification, this paragraph is fulfilled by the final report plus the durable `cw-feedback:needs-input` labels.

### Step 5: Reconcile the issues this run touched (GitHub is the source of truth)

GitHub must reflect what actually shipped before the run ends — reconcile every issue it touched per the [issue-reconciliation contract](../cw-orchestrate/references/issue-reconciliation.md). The build path's only built-in reconciliation is the PR's `Closes #<issue>` keyword auto-closing the one feedback issue; a missing keyword, a parent that tracks the issue, cross-references, or a description that no longer matches what shipped are all on this step. For each entry in the report's `built` list with `merged: true`:

1. **Confirm the feedback issue actually closed; close it if not.** `gh issue view <issue> --json state`. A merged PR whose body carried `Closes #<issue>` auto-closed it; if it is still `OPEN` (the keyword was omitted), close it: `gh issue close <issue> --comment "Shipped via PR #<pr>. <one line>"`. Never close an issue whose PR is `merged: false` (stalled) — leave it open with its cause.
2. **Update the feedback issue's description if the change diverged from the captured intent.** When what shipped differs from the "What I want changed" the feedback recorded (different approach, narrower/broader scope, follow-ups split into new issues), edit the body so it reads true (contract rule 4); otherwise the closing comment is enough.
3. **Reconcile anything that tracks or references it** (contract rules 2–3, 5). If the feedback issue appears in a parent/tracking/milestone checklist, tick its line `- [x]`, and close that parent if this was its last open child and nothing else is deferred/stalled. Reconcile any issue the feedback body or the PR `Relates to`/mentions: tick/close/annotate as its state now warrants, or post a one-line "addressed by PR #<pr>". Most dogfooding-feedback issues are standalone, so this is often a no-op — do it only when there is a real reference.
4. **Verify.** Re-read the closed issues and any tracker you edited to confirm the edits landed.

For umbrellas this run filed (Step 3), reconciling their sub-issues is `cw-orchestrate`'s Step 7 — don't duplicate it here. This step runs **before** the worktree cleanup (Step 6): GitHub truth first, local tidiness second.

### Step 6: Clean up the run's worktrees and heal the default branch

This step *heals* the primary checkout; the invariant that keeps it healable — all work in worktrees, never a commit on the primary checkout — and the enforcing `pre-commit` hook are in [cw-orchestrate's worktree-discipline.md](../cw-orchestrate/references/worktree-discipline.md).

After the report is surfaced, remove the debris the background Workflow leaves behind. The `build` subagents run with `isolation: 'worktree'`, so each leaves a `wf_<workflowRunId>-NN` worktree **and** a local feature branch. The serialized merge step's `gh pr merge --delete-branch` deletes the **remote** branch but leaves the local worktree and branch; and because `gh` runs from inside a worktree, its post-merge local cleanup often fails noisily and can leave the default-branch checkout switched onto a feature branch with local `<defaultBranch>` sitting behind the squash commits — that is what makes a later `git pull` report divergent branches. Heal all of this automatically, **scoped strictly to this run's artifacts**:

1. **Capture the `workflowRunId`** the Workflow tool returned at launch in Step 2 (e.g. `wf_f589ef2f-d48`). Only worktrees whose path matches `.claude/worktrees/<workflowRunId>-*` are in scope — never other runs' `wf_*` worktrees, never named/human worktrees, never the session's own worktree. (Concurrent `cw-ship`/`cw-sweep`/`cw-orchestrate` runs each scope to their own `workflowRunId`, so they never touch each other's worktrees.)
2. **Remove vs. keep is decided by merge state, never by guesswork.** For each in-scope worktree, read its branch (`git worktree list`), then:
   - **Merged + clean** — its PR is `MERGED` (remote branch gone: `git ls-remote --heads origin <branch>` is empty) **and** `git -C <wt> status --porcelain` is empty → `git worktree unlock <wt> 2>/dev/null; git worktree remove --force <wt>; git branch -D <branch>`. Then also delete the worktree's **auto-created placeholder branch** `worktree-<basename-of-wt>` (verify `git merge-base --is-ancestor worktree-<name> origin/<defaultBranch>` before `git branch -D`).
   - **Stalled or dirty** — the remote branch still exists (a build that hit a mid-flight fork and left an open PR), or the worktree has uncommitted changes → **keep it untouched** and name it in the cleanup summary.
3. **Heal the default branch.** `git fetch origin <defaultBranch>`. If the primary checkout (or any surviving worktree) is parked on a now-deleted feature branch, switch it back to `<defaultBranch>` (untracked files are preserved across the switch). Then advance local `<defaultBranch>` to `origin/<defaultBranch>`: `git branch -f <defaultBranch> origin/<defaultBranch>` when nothing has it checked out, else `git -C <checkout> merge --ff-only origin/<defaultBranch>`. A local-only commit on `<defaultBranch>` here is the **un-squashed twin** of a commit already on `origin/<defaultBranch>` (a squash-merge artifact), so advancing loses no work — confirm with `git log origin/<defaultBranch>..<defaultBranch>` showing only such twins before forcing.
4. `git worktree prune`, then report what was removed and what was deliberately kept.

The merge-state gate is what makes this safe to run unattended: a worktree is removed only when its work is provably on `<defaultBranch>` and the tree is clean. Never remove a worktree with uncommitted changes or an unmerged branch. Cleanup is **run-scoped** (only this run's `workflowRunId` worktrees) precisely so concurrent runs never touch each other's artifacts — that invariant is what lets cw-ship runs overlap with no lock.

## Key Notes

- **The blocking point is a design fork, nothing else.** The loop only stops for a decision your feedback didn't settle. It does not stop to let you review PRs — that's the whole point. If you find yourself wanting to review the small ones, that's a signal to start with `build: false` until you trust the routing, not to add a review gate.
- **Clearing parks is one action: run the `cw-resolve` skill.** It finds every `cw-feedback:needs-input` issue, walks you through the questions (recommended answer pre-filled), writes your answers into the body, and adds `cw-feedback:go`. A park-time push notification tells you when there's something to clear. The loop never resumes a parked issue without `cw-feedback:go` and never re-asks an answered question.
- **Build conservatism mirrors cw-sweep.** A subagent that hits an unsettled fork mid-build reports `needs-input: <question>` rather than guessing; that issue parks back to you instead of merging a wrong call. Auto-merging a wrong change is worse than parking.
- **GitHub is the source of truth (Step 5).** A merged change isn't done until GitHub reflects it: the feedback issue closed (the `Closes` keyword usually does this, but a missing keyword is closed as a safety net), its description updated if the change diverged from the captured intent, and any parent/tracker/cross-reference reconciled. Standalone feedback issues make this a near no-op; issues tracked by a parent or referencing others get the same close/tick/update as cw-orchestrate's Step 7. The shared contract is [issue-reconciliation.md](../cw-orchestrate/references/issue-reconciliation.md).
- **Self-cleaning (Step 6).** In Workflow mode, all implementation happens in `isolation: 'worktree'` build subagents, never on the default checkout. In portable foreground mode, create equivalent explicit `git worktree` checkouts for build work and treat the foreground run id or branch prefix as the cleanup scope. After the run the main session removes its own run-scoped worktrees and local branches and heals the default-branch checkout — scoped to this run and gated on merge state — so the working copy is left clean on `<defaultBranch>` matching `origin`.
- **Concurrency is per-issue, not per-repo (Step 1).** There is no run lock — N runs may overlap on the same repo. Each issue is serialized by an atomic claim (a `<!-- cw-ship/claim -->` comment + `cw-feedback:triaging`), verified after acquisition (earliest non-stale claim by `created_at`, ties by lowest comment id) so a snapshot→claim race resolves to exactly one owner. No run ever steals another's claim on a liveness guess; a genuinely crashed claim (>2h, no open PR, no recent update) is reclaimable by **age**, never by PID. Every run re-discovers from live labels, so a missed/partial/crashed run self-heals next tick. Contract: [references/state-machine.md](./references/state-machine.md).
- **Umbrella handoff uses the existing seam, with no approval gate.** This skill files a *ready* umbrella and lets `cw-orchestrate` execute it — it does not reimplement orchestration. Filing and orchestration are both autonomous: an umbrella-sized issue whose intent is clear is filed and handed off directly, with no `cw-feedback:go` gate and no "shall I orchestrate?" confirmation. The only thing that would have stopped it — a genuine design fork — parks as `cw-feedback:needs-input` *instead of* routing umbrella, so by the time an umbrella is filed there is nothing left to approve. (`build: false` is the escape hatch: it reports the umbrella disposition but files nothing.)
- **Derived issues stay self-contained (Step 2 umbrella authoring).** The umbrella and sub-issues this run files must be executable by cw-orchestrate's headless sweep from the issue text + committed repo alone. The authoring subagent inlines every decision and never carries forward — or strengthens — a reference to an uncommitted/local artifact it inherits from the feedback body (the failure that let a feedback issue cite an uncommitted brainstorm doc as "the planning input"). It verifies any repo path it cites exists on the default branch before citing it. This is the downstream half of `cw-feedback`'s self-containment gate.
- **Git/PR via `gh`/`git`, not MCP** — background Workflow subagents may not have interactively-authenticated MCP servers.
