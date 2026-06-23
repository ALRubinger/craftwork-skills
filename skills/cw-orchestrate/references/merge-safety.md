# Merge Safety

The work stage runs in a **no-human window**: N worktree subagents producing PRs that merge to the default branch with nobody watching. Merge safety is the set of guarantees that make that window safe (R14, R15, R16). The governing principle: **`main` advances deterministically, one merge at a time, and never absorbs an unexpected conflict, a P0, or a red/pending CI run.**

> **Base vs. target.** Two roles, one branch in the common case (see `manifest-schema.md`). The *merge target* — the branch the squash-merge lands on, that the pre-merge `git merge-tree` check diffs the PR branch against, AND that work subagents fork off (so each node builds on the run's accumulated work) — is `targetBranch`, which defaults to `defaultBranch`. `base` here means the *freshness source* (`defaultBranch`): the Step 4.5 ensure merges it into the merge target before launch so the fork base stays fresh, and the merge step re-fetches it only as the merge-tree dedup reference. When they differ (e.g. landing an umbrella's PRs on an integration branch), fork off / merge onto / merge-tree against `targetBranch`, with `defaultBranch` kept merged in for freshness. The shell snippet below makes this split explicit: `base` (the freshness source) and a distinct `target` (`${TARGET_BRANCH:-$DEFAULT_BRANCH}`, the merge-tree/merge target) are both fetched. When `TARGET_BRANCH` is unset, `target == base` and the snippet is identical to the single-branch case.

## The six guarantees

1. **Serialized merges (R14).** At most one node merges to the default branch at a time. The work role *builds* in parallel (each in its own worktree); the orchestrator *merges* serially. A single in-script merge step processed one node at a time is the lock — there is no concurrent `gh pr merge`.

2. **Pre-merge conflict check (R14, AE5).** Immediately before each merge, re-fetch the merge target and run a real `git merge-tree` of the PR branch against the **fresh** target (`main` in the single-branch case, `integration/<slug>` on a target run). Scheduling used *predicted* ownership (set-intersection over plan ownership tables); this is the *actual* diff check. An unexpected conflict (one the schedule did not predict) → **halt and re-queue** the node rather than force-merging.

3. **Pre-merge CI gate — wait for green, then merge (R14).** Before `gh pr merge`, the merge step blocks until the PR's own checks conclude (`gh pr checks --watch`) and merges **only** when every *blocking* check (build, unit/integration tests, lint, vet, type/Svelte check, smoke, security scans) concluded `success`. It never merges over a `pending` or failing blocking check — `--admin` bypasses required-review, not in-progress or failing validation. *Advisory* soft gates (coverage thresholds like `codecov/patch`/`codecov/project`; preview/deploy checks like a Railway `… - docs` deployment that reports `cancelled`) do not block; they are recorded in `ci.advisory_nonblocking` and the merge proceeds. A failing blocking check → the node does **not** merge and is stalled with the failing check named (the work step, not the merge step, owns fixing it). This gate is what keeps a regression a CI caught — but a local run did not — off `main`.

4. **P0 code-review halt (R15).** The work role runs a code-review pass on its own diff. A P0 finding leaves the PR **open** and marks the node stalled — it never merges. Non-P0 findings file-and-proceed.

5. **Dependents plan AND build on the fresh merge target (R16).** Execution is **per-node gated**, not barrier-waved: a node's whole chain (plan → work → merge) defers until every predecessor has merged onto the target. So a dependent both *plans* and *builds* against a target that already carries its prerequisites' merged code — it is never planned blind, up front, against a surface its prerequisite hasn't landed on yet. Each merge advances the target; eligible dependents then fork off the new tip (which is `main` in the single-branch case, `integration/<slug>` on a target run). A dependent that hits a conflict it cannot safely auto-resolve in a headless context → **halt the job and its dependents and file an issue** (no force-resolve).

6. **No force-resolve, ever (R16).** A headless context must not pick a side of a conflict. Unresolvable rebase/merge conflicts halt; they do not get `-X ours`/`-X theirs`'d away.

## Per-node gating + serial-merge structure

Execution is driven by a continuous eligibility check, not a fixed sequence of barrier waves. `eligible(nodes, merged)` (the pure scheduler, canonical in `scheduler.mjs`, mirrored into `workflow.js`) returns every not-yet-merged node whose predecessors (declared `depends_on` ∪ file-overlap) are all merged. The driver fires those nodes' chains in parallel; each merge advances the merged set and unblocks the next eligible nodes.

```
merged = {}
loop until no node can advance:
    cascade-stalls()                                        # a stalled/P0 node halts its transitive dependents
    planEligible  = eligible(nodes, merged)  restricted to declared-dep edges, not yet planned
    plan+review+file-residual(planEligible) in parallel     # dependents plan AFTER prereqs merge → never blind
    workEligible  = eligible(planned-nodes, merged)         # full edge model: declared deps ∪ file-overlap
    built = parallel( work-subagent per workEligible node ) # isolated worktrees, build+PR+self-review
    for each node in built (serially, ascending):           # ← the merge lock
        if halted/stalled by build (ready_to_merge=false or p0): record + halt dependents; continue
        merge-step(node)                                    # pre-merge check → gh pr merge → verify
        on merge: merged += node                            # the next loop pass re-evaluates eligibility
```

Planning is gated on **declared deps only** — file-overlap is a merge-contention concern, not a plan-correctness one, so two file-overlapping nodes may plan concurrently; their contention is caught at merge time by the serial merge lock + pre-merge `git merge-tree` check. Eligible nodes plan and build **in parallel** (throughput); merges run **serially** (determinism). A node never starts until its prerequisites have merged, so dependents always plan and build on merged prerequisites.

## The merge step

Run per eligible node, serially. Operates on the **remote** PR (the branch was pushed by the work subagent), so no worktree is needed.

```bash
repo="$REPO"; base="$DEFAULT_BRANCH"; target="${TARGET_BRANCH:-$DEFAULT_BRANCH}"; branch="$NODE_BRANCH"; pr="$NODE_PR"

# 1. Re-fetch the freshness base, the merge target, and the PR branch.
#    (When TARGET_BRANCH is unset, target == base and this is the same fetch as before.)
git fetch origin "$base" "$target" "$branch"

# 2. Pre-merge conflict check against the FRESH merge target (R14).
#    merge-tree exits non-zero / reports conflicts if the merge would conflict.
if ! git merge-tree --write-tree --name-only "origin/$target" "origin/$branch" >/tmp/mt.out 2>&1; then
    echo "HALT: pre-merge conflict for #$issue against fresh $target; re-queue (do not force-merge)"
    # mark node stalled(cause="pre-merge conflict"); re-queue once, then halt + dependents if it recurs
    exit 0
fi

# 3. PRE-MERGE CI GATE (R14): wait for the PR's checks to conclude, then merge
#    ONLY when every blocking check is green. NEVER merge over pending/failing.
gh pr checks "$pr" --repo "$repo" --watch --interval 30   # block until all conclude
#    Read final conclusions and split blocking vs advisory:
#      - BLOCKING (build, unit/integration tests, lint, vet, type/Svelte check,
#        smoke, security scans) MUST all be `success`. Any failure/timed_out/
#        startup_failure/action_required => do NOT merge: merged:false,
#        ci.failing_checks=<names>, cause "pre-merge CI failed: <checks>".
#      - ADVISORY (codecov/patch, codecov/project; preview/deploy like a Railway
#        `… - docs` deployment reporting `cancelled`) => soft gate, does NOT
#        block; record in ci.advisory_nonblocking and proceed.
#      - If checks never conclude (~30 min) => merged:false, cause "… timeout".
#    When unsure whether a check is blocking, treat it as BLOCKING.

# 4. Only when every blocking check is green: serialized squash-merge with
#    --admin, delete branch (repo-family convention).
gh pr merge "$pr" --repo "$repo" --squash --admin --delete-branch

# 5. Verify MERGED state and branch deletion (R17 green predicate, part 1).
state=$(gh pr view "$pr" --repo "$repo" --json state --jq .state)   # expect "MERGED"
git ls-remote --exit-code --heads origin "$branch" && \
    git push origin --delete "$branch"   # gh's local cleanup often fails from a worktree; verify + delete

# 6. Post-merge CI is now only a RESIDUAL regression detector — the landing
#    already passed CI in step 3, so this rarely fires. Classify the merge
#    commit's checks by CONCLUSION:
#      - cancelled => NOT a failure. GitHub Actions `concurrency: cancel-in-progress`
#        cancels this commit's run whenever a later commit lands on main seconds
#        later (the next serialized node, or an unrelated bot PR like Renovate).
#        Confirm against the main TIP's latest run (which includes your change).
#      - a genuine failure conclusion (not advisory, not cancelled) => surfaced as
#        a post_merge_warning on the MERGED node, NOT a stall (the PR has landed).
```

**Merge verdict schema (`MERGE_SCHEMA`)** returned by the merge step:

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["issue", "merged"],
  "properties": {
    "issue":       { "type": "integer" },
    "merged":      { "type": "boolean" },
    "pr_state":    { "type": ["string", "null"] },
    "branch_gone": { "type": ["boolean", "null"] },
    "ci": {
      "type": ["object", "null"],
      "additionalProperties": false,
      "properties": {
        "failing_checks":       { "type": "array", "items": { "type": "string" } },
        "advisory_nonblocking": { "type": "array", "items": { "type": "string" } },
        "cancelled":            { "type": "boolean" },
        "pending":              { "type": "boolean" }
      }
    },
    "cause":       { "type": ["string", "null"] }
  }
}
```

The merge step reports CI **facts** (`ci`). The pre-merge gate (step 3) is what decides whether the PR merges at all: it lands only when every blocking check is green. The post-merge `classifyPostMergeCI` (pure, unit-tested, canonical in `merge-ci.mjs`, mirrored into `workflow.js`, drift-guarded by `mirror.test.mjs`) now only distinguishes a residual regression (`failed`) from `superseded`/`pending`/`green` for **warning** purposes; it no longer flips a merged node to stalled.

## Merge / stall predicate (R17)

The landing is gated green pre-merge, so the predicate is simply:

> A node is **merged** iff `pr_state === "MERGED"` (via the GitHub API) with its branch gone. A node that merged is **never** relabeled stalled — that would imply it did not land. If post-merge CI later flags a genuine regression on the merge commit (`classifyPostMergeCI(ci) === "failed"`), it is surfaced as a `post_merge_warning` on the merged node (and does not halt dependents — the code is already on `main`).

A node is **stalled** only when it did **not** land, with a recorded cause:
- **Pre-merge CI failed** → stalled (`cause: "pre-merge CI failed: <checks>"`); its dependents halt because they would build on code that never landed. This is the common case the gate now catches *before* anything reaches `main`.
- Pre-merge conflict that re-queue did not clear → stalled (`cause: "pre-merge conflict against main"`).
- PR closed-not-merged → stalled (a closed PR is not a merge).

**A cancelled post-merge run is NOT a stall** (and, post-gate, not even a warning unless it masks a real failure). On an active default branch, GitHub Actions `concurrency: cancel-in-progress` cancels a commit's CI run the moment a later commit lands — the next serialized node, or an unrelated bot PR such as Renovate. A cancellation is not a failure: treating "not green" (which includes `cancelled`) as a failure falsely stalls a cleanly-merged node and cascade-halts its dependents. This exact false stall happened on a real run (#1050: #1051 merged clean, its post-merge CI was cancelled by a Renovate merge, and #1052/#1053 were wrongly halted). `classifyPostMergeCI` exists to prevent it: only an actual failing conclusion — confirmed against the default-branch tip when the merge commit's own run was cancelled — counts as `failed`. A still-`pending` run likewise does not stall (the next eligible node builds and full-tests on fresh `main`, which catches a real regression).

## Failure cascade (R17)

A stalled node — or a P0-halted node — halts its **transitive dependents** in the dependency graph (the same edges the scheduler used: declared `depends_on` ∪ file-overlap). Independents are unaffected and run to completion. Because the chain is per-node gated, a halted predecessor stops its dependents **from ever planning, not just from working**: a dependent whose prerequisite halted never reaches the plan gate, so the run does not waste a plan/review cycle on work that can never land. The orchestrator skips halted dependents — it neither plans nor starts them — and records each in the report with its cause.

This is the whole point of the no-human-gate design having teeth: a failed linchpin (e.g. #981) cleanly stops #984/#985/#986 — none of them even plan — and lets #980/#982/#983/#987/#988 finish, rather than planning or building dependents on a foundation that never landed.

## Re-queue policy

A pre-merge conflict re-queues the node **once**: re-fetch `main`, and if the work subagent's branch can be cleanly rebased the merge is retried. If the conflict persists (or a rebase needs human judgment), the node halts with cause and its dependents cascade. Re-queue is bounded — there is no unbounded retry loop in a headless window.
