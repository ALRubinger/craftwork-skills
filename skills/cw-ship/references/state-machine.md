# The feedback label state machine

`cw-feedback` (capture) and `cw-ship` (the loop) communicate entirely through one GitHub issue and its labels. The issue **body** is the async sync point for design questions; the **labels** are the state. This is the same author/executor seam as cw-scope → cw-orchestrate, with the issue body standing in for the readiness brief.

## Labels

| Label | Meaning | Set by |
|-------|---------|--------|
| `feedback` | This issue is a piece of dogfooding feedback (filter handle). | capture |
| `feedback:new` | Captured, awaiting first triage. | capture |
| `feedback:triaging` | A loop run is actively working this issue (per-issue lock). | the loop, while in flight |
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

A loop run processes every issue that is **`feedback:new` OR `feedback:go`** and **NOT `feedback:triaging`**. The first thing it does to an in-scope issue is add `feedback:triaging` (the lock) and remove the entry label. The last thing it does is one of:

- **Resolved:** the PR's `Closes #<issue>` closes the issue on merge. Remove `feedback:triaging`.
- **Parked:** add `feedback:needs-input`, remove `feedback:triaging`. The `## Open questions` block is appended to the body.
- **Umbrella handed off:** close the issue with a "tracked by #<umbrella>" comment; remove `feedback:triaging`.

## Why two parking reasons share one state

Both "I need a design decision from you" and "this is umbrella-sized — approve the proposed scope" resolve the same way: questions/scope go into the body, label flips to `feedback:needs-input`, operator answers and adds `feedback:go`. Keeping them one state means one habit for the operator: **read the body, answer, add `feedback:go`.** The loop distinguishes them internally (the umbrella case carries a proposed scope in the body); the operator's action is identical.

## The go gate (operator's only routine action)

When a run parks anything, cw-ship's SKILL fires a **push notification** (`escalations` non-empty) so the operator knows input is waiting. The operator then runs **`/cw-resolve`**, which is the mechanism for the go gate: it finds every `feedback:needs-input` issue and, per issue:

1. Reads the `## Open questions` (or `## Proposed umbrella scope`) block.
2. Asks the operator each question via `AskUserQuestion`, recommended answer first.
3. Writes the answers inline into the body and swaps `feedback:needs-input` → `feedback:go`.

(The operator can also do this by hand on GitHub — answer inline, add `feedback:go` — but the inbox skill is the intended path.) From the moment an issue carries `feedback:go` it is autonomous to merge — no PR review, mirroring cw-orchestrate's "once I say go" contract. The loop never resumes a parked issue without `feedback:go`; it never re-asks a question the operator already answered, because `/cw-resolve` is the *only* automated thing that adds `feedback:go`, and it does so only after a real answer.

## Idempotency and the lock

Every run re-discovers from live labels, so a missed, partial, or crashed run self-heals on the next tick. The `feedback:triaging` lock prevents two overlapping runs from double-processing one issue. A stuck `feedback:triaging` with no live run (e.g. a crashed run) is safe to clear by hand — the next run re-picks the issue from `feedback:new`/`feedback:go` once the lock is removed.
