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

The skill runs **one interactive readiness sweep** in the main session — the single human touchpoint — then writes a per-run **manifest** and launches a background **Claude Code Workflow** that plans, doc-reviews, schedules by dependency, and works each sub-issue through to a serialized, safety-gated squash-merge. After you say "go," no further human input is solicited until the run reports back. Once it does, the main session reconciles GitHub state — closing merged-but-open sub-issues, ticking the umbrella checklist, and updating the parent issue so GitHub stays the source of truth (Step 7) — then cleans up its own worktrees and branches and heals the default-branch checkout (Step 8), so a completed run leaves both GitHub and the repo tidy.

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
gh issue view "$umbrella" --json number,title,body
# Sub-issues: prefer the native sub-issue link, else parse the umbrella body's checklist.
gh issue view "$umbrella" --json subIssues --jq '.subIssues[] | select(.state=="OPEN") | .number' 2>/dev/null \
  || echo "(fall back to parsing the umbrella body for #NNN references and filter to open)"
```

Resolve each candidate to `{number, title, state}` and drop anything not `OPEN`. Closed sub-issues are excluded (R1). Then apply the scope filter: if `--only` is set, keep only those numbers (error if any named number is not an open sub-issue of the umbrella); if `--except` is set, drop those. Present the resulting in-scope set to the operator before sweeping, and state explicitly which sub-issues were excluded by scope so the run's blast radius is unambiguous.

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
- Briefs and the manifest live under a run-scoped working directory the background Workflow can read by absolute path (see manifest-schema.md for the location decision).

Then get an explicit **"go"** from the operator (AskUserQuestion). This is the last human checkpoint (R4). Show the routed list, the dependency edges, and the manifest path before asking.

### Step 5: Launch the Workflow

After "go," launch the background Workflow with the manifest as `args`:

> Invoke the **Workflow** tool with `scriptPath` pointing at this skill's `workflow.js`, and `args` set to the manifest object (the manifest itself, not a path to it). The Workflow runtime delivers `args` to the script as a JSON **string**, so `workflow.js` parses it before use — pass the object and the script handles marshaling. The Workflow runs headless in the background; you will be notified on completion. Do not poll.

The Workflow performs, in order (see `workflow.js` and [references/subagent-roles.md](./references/subagent-roles.md)):

1. **Plan** — a plan subagent per ready issue, in parallel, each emitting a plan + a machine-parseable file-ownership table (R7, R8).
2. **Review (Stage 1.5)** — a doc-review subagent per plan; a P0 finding halts that sub-issue (and its dependents) and files a `review-residual` issue; non-P0 findings file-and-proceed (R9, R10, R11, AE3).
3. **Pre-flight schedule** — declared deps ∪ file-overlap (set-intersection over ownership tables) → ordered waves (R12, AE2, AE6).
4. **Work** — a work subagent per node in wave order, each in its own worktree, taking the issue through implementation → PR → serialized squash-merge with the full merge-safety contract (R13–R16, AE5).
5. **Triage** — the moment a node merges, its filed `review-residual` issue is re-judged against the now-shipped diff: each finding classified `RESOLVED` / `FIX_NOW` / `DECISION` / `MOOT`, a triage comment posted, and the residual closed if nothing actionable remains. Fired without holding the merge lock. See [references/residual-triage.md](./references/residual-triage.md).
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

GitHub is the authoritative record of what work is done and still needs doing. The run does **not** keep it current on its own: a squash-merge auto-closes a sub-issue only when its PR body carried a `Closes #NNN` keyword, and the umbrella's checklist and the parent issue never update themselves. So after the report, reconcile every issue the run touched so a reader sees the true state on GitHub without consulting the run logs.

1. **Re-read live state.** For every sub-issue in the manifest, `gh issue view <n> --json state,stateReason`. For each merged node, confirm its PR is `MERGED` and whether the issue auto-closed (`gh pr view <pr> --json closingIssuesReferences`).
2. **Close merged-but-open sub-issues.** A node whose PR merged green but whose issue is still `OPEN` (the PR omitted a closing keyword) → `gh issue close <n> --comment "Merged via PR #<pr>. <one line>"`. Never close a **stalled** node's issue — its PR is open or its work is incomplete.
3. **Update the umbrella's checklist.** Read the umbrella body (`gh issue view <umbrella> --json body`), then for each line `- [ ] #NNN`: tick to `- [x]` for every merged sub-issue; for **deferred/excluded** (sweep) or **stalled** (run) sub-issues leave it unchecked and annotate the line with the reason ("— **deferred**: <why>" / "— **stalled**: <cause>, PR #NNN open") so the list reads true. Add a short dated **Status** line and a **Residual follow-ups** list — and **annotate each residual with its triage disposition**, not just a link, so a reader sees the true state: `closed (resolved/moot)`, `closed via PR #NNN` (close-via-autofix), `open — escalation: <one-line>` (keep-open, needs a human), or `deferred — feature not yet shipped`. This mirrors the `cw-sweep` skill's Step 4 so both the in-band and out-of-band paths leave the umbrella's residual section identically true. Apply with `gh issue edit <umbrella> --body-file <file>` — a body-file (or quoted heredoc) preserves backticks and `- [ ]` syntax; do not hand-escape.
4. **Post a run-summary comment on the umbrella**: the merged / stalled / deferred table, residual links, and any production bug the shepherding surfaced.
5. **Close the umbrella when it is fully done.** After the checklist is reconciled, if **every** in-scope sub-issue is resolved (merged or closed) **and** nothing is deferred or stalled **and** no residual is left `open — escalation` (closed/moot/autofixed residuals are fine), close the umbrella itself: `gh issue close <umbrella> --reason completed --comment "All sub-issues and residuals resolved. <one-line outcome>"`. Otherwise leave it **open** — a fully-ticked-but-still-open umbrella is wrong only when there is genuinely nothing left; any open deferred/stalled item or live escalation means the umbrella is still tracking work. Never close an umbrella that still carries unresolved items.
6. **Update the parent issue the umbrella names** (e.g. a `Parent: #747` line). If the parent has a checklist entry for the umbrella, flip it to `[x]` **only when every in-scope sub-issue is resolved** (nothing deferred or stalled remaining); otherwise leave it unchecked and post a progress comment so the milestone reflects partial completion. Never mark a parent line done while the umbrella still carries open deferred/stalled items.
7. **Verify.** Re-read the umbrella checklist and the closed sub-issues to confirm the edits landed.

The invariant: when the run ends, the umbrella, its sub-issues, and its parent on GitHub all reflect the true current state — including the umbrella itself closed when (and only when) everything under it is resolved. Reconciliation runs **before** local cleanup (Step 8) — GitHub truth first, local tidiness second.

### Step 8: Clean up the run's worktrees and local branches

This step *heals* the primary checkout after the fact; the standing invariant that keeps it healable — all work in worktrees, the primary checkout's default branch a pure fast-forward mirror of `origin` — and the `pre-commit` hook that enforces it are in [references/worktree-discipline.md](./references/worktree-discipline.md).

After the report is surfaced, the main session removes the debris the background Workflow leaves behind. The Workflow's work subagents run with `isolation: 'worktree'`, so each leaves a `wf_<workflowRunId>-NN` worktree **and** a local feature branch. The serialized merge step's `gh pr merge --delete-branch` deletes the **remote** branch but leaves the local worktree and branch; and because `gh` runs from inside a worktree, its post-merge local cleanup often fails noisily and can leave the default-branch checkout switched onto a feature branch with local `<defaultBranch>` sitting behind the squash commits. Heal all of this automatically, **scoped strictly to this run's artifacts**:

1. **Capture the `workflowRunId`** the Workflow tool returned at launch (e.g. `wf_f589ef2f-d48`). Only worktrees whose path matches `.claude/worktrees/<workflowRunId>-*` are in scope — never other runs' `wf_*` worktrees, never named/human worktrees, never the session's own worktree.
2. **Remove vs. keep is decided by merge state, never by guesswork.** For each in-scope worktree, read its branch (`git worktree list`), then:
   - **Merged + clean** — its PR is `MERGED` (remote branch gone: `git ls-remote --heads origin <branch>` is empty) **and** `git -C <wt> status --porcelain` is empty → `git worktree unlock <wt> 2>/dev/null; git worktree remove --force <wt>; git branch -D <branch>`. Then also delete the worktree's **auto-created placeholder branch** `worktree-<basename-of-wt>` — `git worktree remove` leaves it behind, and it points at a now-merged base commit (verify `git merge-base --is-ancestor worktree-<name> origin/<defaultBranch>` before `git branch -D`). Both the work subagent's feature branch and this placeholder must go for the run to be fully tidy.
   - **Stalled or dirty** — the remote branch still exists (an open PR a human must finish), or the worktree has uncommitted changes → **keep it untouched** and name it in the cleanup summary. A stalled node's worktree is where the fix continues; removing it would destroy in-progress recovery work.
3. **Heal the default branch.** `git fetch origin <defaultBranch>`. If the primary checkout (or any surviving worktree) is parked on a now-deleted feature branch, switch it back to `<defaultBranch>` (untracked files are preserved across the switch). Then advance local `<defaultBranch>` to `origin/<defaultBranch>`: `git branch -f <defaultBranch> origin/<defaultBranch>` when nothing has it checked out, else `git -C <checkout> merge --ff-only origin/<defaultBranch>`. A local-only commit on `<defaultBranch>` at this point is the **un-squashed twin** of a commit already on `origin/<defaultBranch>` (a squash-merge artifact), so advancing loses no work — confirm with `git log origin/<defaultBranch>..<defaultBranch>` showing only such twins before forcing.
4. `git worktree prune`, then report what was removed and what was deliberately kept (stalled worktrees and their branches).

The merge-state gate is what makes this safe to run unattended: a worktree is removed only when its work is provably on `<defaultBranch>` and the tree is clean. Never remove a worktree with uncommitted changes or an unmerged branch, and never touch the run-scoped `.cw-orchestrate/<runId>/` scratch on a run that stalled (its briefs/manifest aid the re-run).

## Key Notes

- **The sweep is the only human touchpoint.** Everything after "go" is hands-off by design. If a sub-issue is not ready, resolve it in the sweep — do not rely on the headless planner to invent the missing decision.
- **Success is quality, not throughput.** "Nine merged" is a proxy. The bar is PRs an operator would have approved. Every P0 — in a plan or a diff — halts or is filed, never silently shipped (R19).
- **The run cleans up its own residuals.** Filed `review-residual` issues are not left to pile up: each is re-triaged against shipped code as its node merges, closed if resolved/moot, and high-confidence fixes are auto-applied in a final sweep. The confidence gate is load-bearing — only fixes the triage subagent is sure are correct, safe, and in-scope merge unsupervised; everything ambiguous becomes an operator escalation. So a clean run leaves behind only judgment calls and unshipped-feature deferrals, not a technical backlog.
- **Merges are serialized and gated on green CI.** One merge to the default branch at a time; every merge re-runs `git merge-tree` against fresh `main` and then **waits for the PR's own checks to conclude, merging only when every blocking check (build/tests/lint/type/smoke) is green** — it never merges over a pending or failing check (`--admin` bypasses required-review, not validation). Advisory soft gates (coverage thresholds, preview deploys) don't block. A merged node is never relabeled "stalled"; a failing blocking check stalls the node *before* it lands. See [references/merge-safety.md](./references/merge-safety.md).
- **Determinism.** The Workflow forbids `Date.now()` / `Math.random()` / argless `new Date()`. The `runId` and `timestamp` are minted in the main session and passed through the manifest; the scheduler is a pure function.
- **Git/PR via `gh`/`git`, not MCP.** Background Workflow subagents may not have interactively-authenticated MCP servers; the git/PR path uses `gh` and `git` via Bash, which are always available.
- **Reusable.** Umbrella context loads through the manifest, not a separate config mechanism (R20). Run the skill on any parent issue with sub-issues.
- **GitHub stays the source of truth (Step 7).** A run reconciles every issue it touched before it ends: merged-but-open sub-issues are closed (squash-merge auto-closes only with a `Closes #NNN` keyword), the umbrella checklist is ticked for merged work and annotated for deferred/stalled work, the umbrella itself is closed once every sub-issue and residual is resolved (left open otherwise), and the parent issue is updated (its umbrella line flips to done only when nothing is left deferred or stalled). Anyone reading the issues sees the true state without the run logs.
- **Self-cleaning (Step 8).** The run removes its own `wf_<runId>-*` worktrees and local branches and heals the default-branch checkout automatically, scoped to this run's prefix and gated on merge state. Merged nodes' debris is removed; a stalled node's worktree and branch are preserved so the operator can finish the fix in place.
