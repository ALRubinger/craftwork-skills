# The feedback label state machine

`cw-feedback` (capture) and `cw-ship` (the loop) communicate entirely through one GitHub issue and its labels. The issue **body** is the async sync point for design questions; the **labels** are the state. This is the same author/executor seam as cw-scope → cw-orchestrate, with the issue body standing in for the readiness brief.

## Labels

| Label | Meaning | Set by |
|-------|---------|--------|
| `cw-feedback` | This issue is a piece of dogfooding feedback (filter handle). | capture |
| `cw-feedback:new` | Captured, awaiting first triage. | capture |
| `cw-feedback:hold` | Cataloged but on hold: in the backlog, **excluded from discovery** until released. Mutually exclusive with every other state label. | capture or **the operator** |
| `cw-feedback:triaging` | A run holds this issue (paired with a `<!-- cw-ship/claim -->` comment that records the owner). Not a lock — it marks the issue as claimed; ownership and crash-recovery are resolved by the claim, see the claim contract below. | the loop, while in flight |
| `cw-feedback:needs-input` | Parked: open questions are written into the body; waiting on the operator. | the loop |
| `cw-feedback:go` | The operator answered the open questions and cleared this to proceed fully autonomously. | **the operator** |

Colors (created idempotently by whichever skill runs first):
`cw-feedback` 0E8A16 · `cw-feedback:new` FBCA04 · `cw-feedback:hold` C5DEF5 · `cw-feedback:triaging` 1D76DB · `cw-feedback:needs-input` D93F0B · `cw-feedback:go` 0E8A16.

## States and transitions

```
            capture
               │
      ┌────────┴─────────┐
      │ "on hold"        │ (default)
      ▼                  ▼
┌──────────────────┐  ┌─────────────┐
│ cw-feedback:hold │  │ cw-feedback:new │
│ (in backlog,     │  └──────┬───────┘
│  not discovered) │         │
└────────┬─────────┘         │
         │ operator hand-swaps :hold → :new
         └──────────►────────┤
               │  loop picks up (also picks up cw-feedback:go)
               ▼
        ┌──────────────────┐
        │ cw-feedback:triaging │  (lock; overlapping runs skip locked issues)
        └──────┬───────────┘
               │ plan
      ┌────────┼─────────────────────────┐
      │        │                          │
 no open Qs    │ open design Qs           │ umbrella-sized
 (small/med)   │ OR umbrella w/o go       │ AND cw-feedback:go present
      │        ▼                          ▼
      │  ┌──────────────────┐    file umbrella + sub-issues,
      │  │ feedback:needs-   │    hand off to cw-orchestrate,
      │  │ input  (body has  │    link umbrella, close feedback issue
      │  │ ## Open questions)│    as "tracked by #<umbrella>"
      │  └────────┬──────────┘
      │           │ operator answers inline + adds cw-feedback:go
      │           ▼
      │     (re-enters loop on next run as a cw-feedback:go issue)
      ▼
  build branch → PR (Closes #issue) → shepherd → squash-merge → issue auto-closes
```

## The pickup query

A loop run processes every issue that is **`cw-feedback:new` OR `cw-feedback:go`** and **NOT a live `cw-feedback:triaging`**, plus any **`cw-feedback:triaging` whose claim has crashed** (reclaim — see the claim contract). The first thing it does to an in-scope issue is **claim** it (post the claim comment, add `cw-feedback:triaging`, remove the entry label, and verify ownership). The last thing it does is one of, each of which **releases the claim** (deletes the run's claim comment) so the issue is no longer held:

- **Resolved:** the PR's `Closes #<issue>` closes the issue on merge; the merge step removes `cw-feedback:triaging` in the same terminal transition (a closed issue must not keep the in-flight claim label) and releases the claim by deleting the claim comment.
- **Parked:** add `cw-feedback:needs-input`, remove `cw-feedback:triaging`, release the claim. The `## Open questions` block is appended to the body.
- **Umbrella handed off:** close the issue with a "tracked by #<umbrella>" comment; remove `cw-feedback:triaging`; release the claim.
- **Yielded:** the run lost the claim race — it deletes only its **own** losing claim comment and touches nothing else (the winner keeps `cw-feedback:triaging`).
- **Stalled:** the build left an open PR but did not merge → **keep** `cw-feedback:triaging` AND the claim. A stalled issue with an open PR is held, not crashed; the open PR is what tells a later run's reclaim check the work is still live.

## The streaming pipeline (per-issue plan→resolve, parallel builds, serial merge)

Within one run, planning and resolving are **not** two barriered phases. Every discovered issue flows through a `pipeline(issues, plan, resolve)`: the moment an issue's *own* plan lands it routes straight onward (build / park / umbrella), without waiting for the slowest plan in the batch. The only synchronized section is the merge.

- **No plan barrier.** Plans run concurrently and each feeds resolve as it completes, so a fast plan can be building while a slow sibling is still planning.
- **Builds fan out in parallel.** Each build runs in its own isolated worktree and opens its own PR. There is no pre-build collision scheduler: two issues that touch the same code both build off the base concurrently.
- **The merge step is the one serialized section.** A promise-chain mutex (`serialMerge` / `mergeTail` in `workflow.js`) ensures only one PR touches the default branch at a time — the merge agent rebases against the *live* branch, so concurrent merges would race. The chain survives a failed merge, so one stalled merge never wedges the queue behind it. Merge/build order is completion-driven; the report rows are sorted by issue for a stable view.

There is **no `predicted_paths` / `global_surface` prediction** and no `computeBuildWaves` — overlap is not avoided ahead of time, it is **resolved at merge time**. This trades a scheduling optimization for pipeline latency (the later of two colliding builds rebases instead of being scheduled after the first), and leans entirely on the serial-merge step as the correctness backstop: it re-checks every PR against the live default branch with `git merge-tree`, so a real collision is always caught and resolved (or stalled) at merge.

### Same-base conflict resolution at merge time

The merge step is no longer one-rebase-and-bail. When a PR conflicts against a fresh default branch a concurrently-built sibling (or another run) just advanced, the merge agent receives the feedback's **intent** (`p.plan.summary`, passed at the call site) and:

1. Rebases the branch onto fresh default and **resolves the conflicting hunks honoring both sides** — preserving both the already-merged change and this feedback's intent. Never `-X ours`/`-X theirs` a whole file; never delete the landed change to make the rebase apply.
2. Treats the resolution as untrusted: **re-runs the full build + test suite** on the rebased head as the gate, force-pushes only if green, then runs the standard pre-merge CI gate and merges.
3. On an **unresolvable** conflict or a **failing re-run**, does NOT force-resolve and does NOT merge — it **stalls** the issue with a legible cause (`same-base conflict against <branch>: unresolvable | resolution failed tests`), leaving `cw-feedback:triaging` and the claim in place (the stalled-but-live case above) for the operator.

## The hold state (cataloged, out of scope until released)

`cw-feedback:hold` lets feedback be filed — or flipped after the fact — into the backlog **without** entering the loop. A held issue carries `cw-feedback` + `cw-feedback:hold` and **no other state label**: hold is mutually exclusive with `:new`, `:triaging`, `:needs-input`, and `:go` (the same single-source-of-truth posture as the claim-vs-terminal invariant below — never two state labels at once). The pickup query lists only `:new`, `:go`, and (for the reclaim pass) `:triaging`; it never lists `:hold`, so a held issue is invisible to discovery by construction — no extra filter needed.

**Releasing a hold is an operator action**, parallel to the hand-flip that adds `:go`: swap `cw-feedback:hold` → `cw-feedback:new` (`gh issue edit <n> --add-label cw-feedback:new --remove-label cw-feedback:hold`), and the issue re-enters the loop on the next run as a fresh `:new`. It is **not** released through `/cw-resolve` — a held issue has no parked questions, so cw-resolve has nothing to ask. If a run is scoped directly at a held issue (`/cw-ship --only <n>`), discovery surfaces it as a legible `held` outcome ("on hold, skipped") rather than silently dropping it.

## Why two parking reasons share one state

Both "I need a design decision from you" and "this is umbrella-sized — approve the proposed scope" resolve the same way: questions/scope go into the body, label flips to `cw-feedback:needs-input`, operator answers and adds `cw-feedback:go`. Keeping them one state means one habit for the operator: **read the body, answer, add `cw-feedback:go`.** The loop distinguishes them internally (the umbrella case carries a proposed scope in the body); the operator's action is identical.

## The go gate (operator's only routine action)

When a run parks anything, cw-ship's SKILL fires a **push notification** (`escalations` non-empty) so the operator knows input is waiting. The operator then runs **`/cw-resolve`**, which is the mechanism for the go gate: it finds every `cw-feedback:needs-input` issue and, per issue:

1. Reads the `## Open questions` (or `## Proposed umbrella scope`) block.
2. Asks the operator each question via `AskUserQuestion`, recommended answer first.
3. Writes the answers inline into the body and swaps `cw-feedback:needs-input` → `cw-feedback:go`.

(The operator can also do this by hand on GitHub — answer inline, add `cw-feedback:go` — but the inbox skill is the intended path.) From the moment an issue carries `cw-feedback:go` it is autonomous to merge — no PR review, mirroring cw-orchestrate's "once I say go" contract. The loop never resumes a parked issue without `cw-feedback:go`; it never re-asks a question the operator already answered, because `/cw-resolve` is the *only* automated thing that adds `cw-feedback:go`, and it does so only after a real answer.

## Concurrency: the per-issue claim contract

**There is no per-repo lock.** N cw-ship runs may execute on the same repo concurrently; the serialization unit is the **issue**. The old `~/.cache/cw-ship/<owner>-<repo>.lock` (a shell `$$` + `trap EXIT` + staleness-by-`ps`) was unsound in this harness: every Bash call is a fresh ephemeral shell, so the recorded PID is dead almost immediately and a liveness check cannot tell a live run from a finished one — which led one run to "reclaim" another's lock as stale and double-process. Nothing in this contract depends on a process being alive.

### The claim

A **claim** is a GitHub issue comment carrying the hidden marker `<!-- cw-ship/claim -->`. Its identity is GitHub's server-assigned `comment id` + `created_at` — authoritative, monotonic, and impossible to forge or skew (no run self-stamps a timestamp).

When a run claims an issue (Plan stage), atomically:

1. **Post** the claim comment; capture its id (`MY_ID`).
2. **Label** `cw-feedback:triaging`, remove the entry label (`cw-feedback:new`/`cw-feedback:go`). Idempotent — harmless if a racing run already did it.
3. **Verify ownership.** Re-read *all* claim comments on the issue. The **owner** is the claim with the **earliest `created_at` among non-stale claims; ties broken by the lowest numeric comment id**. A run proceeds to build *only if `MY_ID` is the owner*.
4. **Yield if not owner.** The loser deletes its own claim comment, leaves `cw-feedback:triaging` for the winner, and does nothing else. This closes the snapshot→claim race: two runs that both saw the issue as `cw-feedback:new` both claim, but exactly one is the owner and the other yields.

### Crash recovery — by age, never by PID

A claim is **stale (crashed)** iff **all** hold: its `created_at` is older than **`CLAIM_TIMEOUT` (2 hours)**, AND there is **no open PR** referencing the issue, AND the issue's `updatedAt` is older than the timeout. Discovery surfaces a `cw-feedback:triaging` issue **only** when its claim is stale; a fresh run then claims it normally (the stale claim is disregarded, so the fresh claim is the sole non-stale one → owner).

The "no open PR AND no recent update" conjunction is load-bearing: a **dead launcher PID does not mean the run is dead** — a crashed launcher can leave a detached background Workflow still building and merging. If that Workflow is alive it has either an open PR or recent issue activity, so its claim is **not** stale and is never reclaimed. Only a run that has left no live artifact for 2h is treated as crashed. (This is the failure that produced a duplicate PR when a dead-PID lock was trusted: the orphan merged while a second run built a dup. The age+artifact rule prevents it.)

### The claim-vs-terminal label invariant

`cw-feedback:triaging` (the in-flight claim) and the **terminal-state** labels (`cw-feedback:needs-input`, `cw-feedback:go`) are **mutually exclusive**: the claim label means a run holds the issue; a terminal label means the run released it. An issue must **never** carry both at once. Every transition keeps this true in a single step:

- **Claiming** (Plan): the claim edit adds `cw-feedback:triaging` and removes the entry labels (`cw-feedback:new` / `cw-feedback:go`) **and** `cw-feedback:needs-input`. An actively-worked issue is not parked, so re-claiming a previously-parked or just-cleared issue strips the terminal label in the same edit.
- **Parking**: add `cw-feedback:needs-input`, **remove `cw-feedback:triaging`** (already atomic in the park step).
- **Merging / closing**: the close is terminal, so the merge step **removes `cw-feedback:triaging`** as the issue closes — a merged feedback issue must not keep the in-flight claim label.
- **Umbrella handoff**: closing the issue removes `cw-feedback:triaging`.

The both-labels state an operator can hit — an issue carrying `cw-feedback:triaging` **and** `cw-feedback:needs-input` at once — is exactly this invariant violated, and it forces a human hand-clean. `violatesClaimInvariant(labels)` in `claim.mjs` is the pure check (unit-tested in `tests/claim.test.mjs`); `tests/claim-state-machine.test.mjs` pins the claim/merge `gh issue edit` label transitions in `workflow.js` that keep it true.

### Safe recovery of a stuck `cw-feedback:triaging` — wait for the auto-reclaim, do not reset by hand

Do **not** manually reset `cw-feedback:triaging -> cw-feedback:new` to "unstick" an issue: a still-live (possibly orphaned) run may own it, and racing it is what duplicates work. A claim is reclaimable **only when provably dead** by the age rule above (no open PR, no recent `updatedAt`, past `CLAIM_TIMEOUT`), at which point the next loop tick reclaims it automatically.

So a run scoped to a live-claimed issue (`/cw-ship --only <n>` on an issue another run holds) does **not** return a bare empty result — that empty/yielded-with-no-context output is what previously read as "nothing in scope" or "stranded" and invited the wrong manual reset. Discovery instead surfaces it as a first-class **`claimed_elsewhere`** entry `{ issue, url, last_activity, claim_age, reclaim_at }`, and the report renders it as a distinct section: *"held by another run, auto-reclaims at `<reclaim_at>`."* `reclaim_at` is the owning claim's `created_at` plus `CLAIM_TIMEOUT` (computed by `reclaimAtIso` in `claim.mjs`). The operator waits for that instant; the loop self-heals.

### Idempotency

Every run re-discovers from live labels + claims, so a missed, partial, or crashed run self-heals on the next tick. A stuck `cw-feedback:triaging` is reclaimed automatically once its claim ages out per the rule above — no manual cleanup needed. The pure resolution logic (`isClaimStale` / `resolveOwner` / `ownsClaim` / `isReclaimable` / `violatesClaimInvariant` / `reclaimAtIso`, with `CLAIM_TIMEOUT_MS`) lives in `claim.mjs` and is unit-tested in `tests/claim.test.mjs`; `planPrompt` and `discoverPrompt` in `workflow.js` implement the same rules via gh (pinned by `tests/claim-state-machine.test.mjs`).
