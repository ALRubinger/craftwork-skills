# The feedback label state machine

`cw-feedback` (capture) and `cw-ship` (the loop) communicate entirely through one GitHub issue and its labels. The issue **body** is the async sync point for design questions; the **labels** are the state. This is the same author/executor seam as cw-scope → cw-orchestrate, with the issue body standing in for the readiness brief.

## Labels

| Label | Meaning | Set by |
|-------|---------|--------|
| `feedback` | This issue is a piece of dogfooding feedback (filter handle). | capture |
| `feedback:new` | Captured, awaiting first triage. | capture |
| `feedback:triaging` | A run holds this issue (paired with a `<!-- cw-ship/claim -->` comment that records the owner). Not a lock — it marks the issue as claimed; ownership and crash-recovery are resolved by the claim, see the claim contract below. | the loop, while in flight |
| `feedback:needs-input` | Parked: open questions are written into the body; waiting on the operator. | the loop |
| `feedback:go` | The operator answered the open questions and cleared this to proceed fully autonomously. | **the operator** |

Colors (created idempotently by whichever skill runs first):
`feedback` 0E8A16 · `feedback:new` FBCA04 · `feedback:triaging` 1D76DB · `feedback:needs-input` D93F0B · `feedback:go` 0E8A16.

## States and transitions

```
            capture
               │
               ▼
        ┌─────────────┐
        │ feedback:new │
        └──────┬───────┘
               │  loop picks up (also picks up feedback:go)
               ▼
        ┌──────────────────┐
        │ feedback:triaging │  (lock; overlapping runs skip locked issues)
        └──────┬───────────┘
               │ plan
      ┌────────┼─────────────────────────┐
      │        │                          │
 no open Qs    │ open design Qs           │ umbrella-sized
 (small/med)   │ OR umbrella w/o go       │ AND feedback:go present
      │        ▼                          ▼
      │  ┌──────────────────┐    file umbrella + sub-issues,
      │  │ feedback:needs-   │    hand off to cw-orchestrate,
      │  │ input  (body has  │    link umbrella, close feedback issue
      │  │ ## Open questions)│    as "tracked by #<umbrella>"
      │  └────────┬──────────┘
      │           │ operator answers inline + adds feedback:go
      │           ▼
      │     (re-enters loop on next run as a feedback:go issue)
      ▼
  build branch → PR (Closes #issue) → shepherd → squash-merge → issue auto-closes
```

## The pickup query

A loop run processes every issue that is **`feedback:new` OR `feedback:go`** and **NOT a live `feedback:triaging`**, plus any **`feedback:triaging` whose claim has crashed** (reclaim — see the claim contract). The first thing it does to an in-scope issue is **claim** it (post the claim comment, add `feedback:triaging`, remove the entry label, and verify ownership). The last thing it does is one of, each of which **releases the claim** (deletes the run's claim comment) so the issue is no longer held:

- **Resolved:** the PR's `Closes #<issue>` closes the issue on merge; release the claim. Remove `feedback:triaging` (the close handles the label, but the claim comment is deleted explicitly).
- **Parked:** add `feedback:needs-input`, remove `feedback:triaging`, release the claim. The `## Open questions` block is appended to the body.
- **Umbrella handed off:** close the issue with a "tracked by #<umbrella>" comment; remove `feedback:triaging`; release the claim.
- **Yielded:** the run lost the claim race — it deletes only its **own** losing claim comment and touches nothing else (the winner keeps `feedback:triaging`).
- **Stalled:** the build left an open PR but did not merge → **keep** `feedback:triaging` AND the claim. A stalled issue with an open PR is held, not crashed; the open PR is what tells a later run's reclaim check the work is still live.

## Why two parking reasons share one state

Both "I need a design decision from you" and "this is umbrella-sized — approve the proposed scope" resolve the same way: questions/scope go into the body, label flips to `feedback:needs-input`, operator answers and adds `feedback:go`. Keeping them one state means one habit for the operator: **read the body, answer, add `feedback:go`.** The loop distinguishes them internally (the umbrella case carries a proposed scope in the body); the operator's action is identical.

## The go gate (operator's only routine action)

When a run parks anything, cw-ship's SKILL fires a **push notification** (`escalations` non-empty) so the operator knows input is waiting. The operator then runs **`/cw-resolve`**, which is the mechanism for the go gate: it finds every `feedback:needs-input` issue and, per issue:

1. Reads the `## Open questions` (or `## Proposed umbrella scope`) block.
2. Asks the operator each question via `AskUserQuestion`, recommended answer first.
3. Writes the answers inline into the body and swaps `feedback:needs-input` → `feedback:go`.

(The operator can also do this by hand on GitHub — answer inline, add `feedback:go` — but the inbox skill is the intended path.) From the moment an issue carries `feedback:go` it is autonomous to merge — no PR review, mirroring cw-orchestrate's "once I say go" contract. The loop never resumes a parked issue without `feedback:go`; it never re-asks a question the operator already answered, because `/cw-resolve` is the *only* automated thing that adds `feedback:go`, and it does so only after a real answer.

## Concurrency: the per-issue claim contract

**There is no per-repo lock.** N cw-ship runs may execute on the same repo concurrently; the serialization unit is the **issue**. The old `~/.cache/cw-ship/<owner>-<repo>.lock` (a shell `$$` + `trap EXIT` + staleness-by-`ps`) was unsound in this harness: every Bash call is a fresh ephemeral shell, so the recorded PID is dead almost immediately and a liveness check cannot tell a live run from a finished one — which led one run to "reclaim" another's lock as stale and double-process. Nothing in this contract depends on a process being alive.

### The claim

A **claim** is a GitHub issue comment carrying the hidden marker `<!-- cw-ship/claim -->`. Its identity is GitHub's server-assigned `comment id` + `created_at` — authoritative, monotonic, and impossible to forge or skew (no run self-stamps a timestamp).

When a run claims an issue (Plan stage), atomically:

1. **Post** the claim comment; capture its id (`MY_ID`).
2. **Label** `feedback:triaging`, remove the entry label (`feedback:new`/`feedback:go`). Idempotent — harmless if a racing run already did it.
3. **Verify ownership.** Re-read *all* claim comments on the issue. The **owner** is the claim with the **earliest `created_at` among non-stale claims; ties broken by the lowest numeric comment id**. A run proceeds to build *only if `MY_ID` is the owner*.
4. **Yield if not owner.** The loser deletes its own claim comment, leaves `feedback:triaging` for the winner, and does nothing else. This closes the snapshot→claim race: two runs that both saw the issue as `feedback:new` both claim, but exactly one is the owner and the other yields.

### Crash recovery — by age, never by PID

A claim is **stale (crashed)** iff **all** hold: its `created_at` is older than **`CLAIM_TIMEOUT` (2 hours)**, AND there is **no open PR** referencing the issue, AND the issue's `updatedAt` is older than the timeout. Discovery surfaces a `feedback:triaging` issue **only** when its claim is stale; a fresh run then claims it normally (the stale claim is disregarded, so the fresh claim is the sole non-stale one → owner).

The "no open PR AND no recent update" conjunction is load-bearing: a **dead launcher PID does not mean the run is dead** — a crashed launcher can leave a detached background Workflow still building and merging. If that Workflow is alive it has either an open PR or recent issue activity, so its claim is **not** stale and is never reclaimed. Only a run that has left no live artifact for 2h is treated as crashed. (This is the failure that produced a duplicate PR when a dead-PID lock was trusted: the orphan merged while a second run built a dup. The age+artifact rule prevents it.)

### Idempotency

Every run re-discovers from live labels + claims, so a missed, partial, or crashed run self-heals on the next tick. A stuck `feedback:triaging` is reclaimed automatically once its claim ages out per the rule above — no manual cleanup needed. The pure resolution logic (`isClaimStale` / `resolveOwner` / `ownsClaim` / `isReclaimable`, with `CLAIM_TIMEOUT_MS`) lives in `claim.mjs` and is unit-tested in `tests/claim.test.mjs`; `planPrompt` and `discoverPrompt` in `workflow.js` implement the same rule via gh.
