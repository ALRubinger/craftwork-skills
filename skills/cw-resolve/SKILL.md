---
name: cw-resolve
description: Resolve the parked decisions the autonomous loops couldn't make alone — /cw-ship feedback (cw-feedback:needs-input), /cw-sweep cw-review-residuals (cw-review-residual:needs-input), and /cw-orchestrate stalled sub-issue parks (cw-status:stalled). Find every parked issue, walk you through its open questions, decisions, or stalled forks one at a time with the recommended answer pre-filled, write your answers back into the issue body, and release it (flip to the matching :go label, or remove cw-status:stalled) so the next loop run executes it autonomously. Trigger when the user wants to answer, clear, or review parked questions or decisions.
metadata:
  version: "0.1.0"
  triggers:
    - (answer|clear|resolve|review).?(the)?.?(parked|pending)?.?(feedback|decision|residual)
    - (feedback|decision).?inbox
    - (what'?s|whats).?(parked|waiting|blocked|pending).?(on)?.?(me|feedback|decision)
    - (feedback|review.?residual).?(needs.?input|questions|decisions)
    - go.?through.?(the)?.?(feedback|decision|residual).?(questions|decisions|inbox)
---

# cw-resolve

Answer the decisions that the autonomous loops parked for you. This is the operator's one routine inbox, and the only skill whose whole job is to take your input. It drains **three** parked queues with the identical recommendation-first flow:

- **Feedback** that `cw-ship` parked (`cw-feedback:needs-input`) — genuine design forks the planner couldn't settle alone. (Being umbrella-sized is no longer parked for approval: an umbrella-sized change with clear intent is filed and orchestrated by cw-ship directly, so the only feedback parks that reach here are real design decisions.)
- **Review-residuals** that `cw-sweep` parked (`cw-review-residual:needs-input`) — judgment calls on shipped code that the residual triage couldn't auto-resolve.
- **Stalled sub-issue parks** that `cw-orchestrate`'s headless repo-scan parked (`cw-status:stalled`) — a sub-issue whose design fork the scan couldn't settle, which blocked its umbrella (swapped `cw-umbrella:ready` → `cw-umbrella:needs-input`). Answering here records the resolution on the sub-issue body and releases the park; the next `cw-orchestrate` scan auto-restores the umbrella.

This is the **third** skill in the feedback pipeline:

```
/cw-feedback        capture     → cw-feedback:new
/cw-ship plan + act  → auto-merge | PARK to body | umbrella
/cw-resolve  answer      → cw-feedback:go ──┐  (this skill)
       ▲                                     │
       └────────── next triage run ──────────┘
```

When the loop hits a genuine design fork — a question your original feedback didn't settle — it writes the question into the issue body and flips the issue to `cw-feedback:needs-input` (the full contract is in [cw-ship's state machine](../cw-ship/references/state-machine.md)). This skill is how you clear those: it gathers them, asks you, records your answers, and adds `cw-feedback:go`. From there the loop is autonomous to merge — you never review the resulting PR. Answering here is the one routine action the pipeline asks of you.

## When to Use

When you want to drain the parked-decision inbox: "answer the feedback questions", "what's waiting on me", "go through the inbox", "decide the residual questions". Covers parked feedback (`cw-feedback:needs-input`), parked cw-review-residual decisions (`cw-review-residual:needs-input`), and stalled sub-issue parks (`cw-status:stalled`). Often prompted by a push notification from a `/cw-ship`, `/cw-sweep`, or `/cw-orchestrate` run that parked something. Do **not** use it to capture new feedback (`/cw-feedback`), to plan/execute feedback (`/cw-ship`), or to triage residuals (`/cw-sweep`).

## Prerequisites

- `gh` (authenticated — `gh auth status`) and `git`.
- Run from inside the target repo (or pass the repo) so detection works.
- The `AskUserQuestion` tool (load its schema via `ToolSearch` `select:AskUserQuestion` if needed).

## Workflow

### Step 0: Detect the repo

`git -C . remote get-url origin` → `owner/name`. If the cwd isn't the intended repo, ask which repo to drain.

### Step 1: Gather the parked issues

Gather all three parked queues:

```sh
gh issue list --repo <repo> --state open --label cw-feedback:needs-input \
  --json number,title,body,url --limit 200
gh issue list --repo <repo> --state open --label cw-review-residual:needs-input \
  --json number,title,body,url --limit 200
gh issue list --repo <repo> --state open --label cw-status:stalled \
  --json number,title,body,url --limit 200
```

If all are empty, say so plainly ("inbox empty — nothing parked") and stop. Otherwise process oldest-first (lowest number first) within each queue so the longest-waiting item clears first. Tell the user how many are parked, and of which kind, before you start. The three kinds differ only in where the parked question lives (Step 2), where the answer is written (Step 4), and how you release (Step 5); the asking flow is identical.

### Step 2: Per issue — read the parked block

Each parked issue carries exactly one of:

- **`## Open questions`** (feedback) — a numbered list of design forks, each often with a recommended answer the planner suggested. (This is the only shape a parked feedback issue takes; umbrella-sized changes are filed by cw-ship directly and never parked for scope approval.)
- **`## Decision needed`** (cw-review-residual) — a numbered list of judgment calls from residual triage, each with the question, a recommended answer, and the alternatives.
- **A `<!-- cw:status -->` marker comment** (stalled sub-issue) — **not** a body block. cw-orchestrate's headless scan upserts one comment on the sub-issue formatted `⏸ needs-input: <the unresolved fork>, parked for /cw-resolve` (see [cw-orchestrate Step 3b](../cw-orchestrate/SKILL.md)). The text after `needs-input:` is the fork to settle. Fetch it with `gh issue view <n> --repo <repo> --json comments -q '.comments[].body' | grep 'cw:status'` (or read the comments and find the one marker).

Read the whole body for context (for feedback: the Observation / What I want changed; for a residual: the finding and its rationale against the shipped code; for a stalled sub-issue: the sub-issue's own body — what the sub-issue asks for — plus its umbrella), then the parked block or marker comment. Restate the issue to the user in one line before asking, so they have context: "_#137 (annoyance: launch banner repeats): 2 questions._", "_#1010 (cw-review-residual for feature #984): 1 decision._", or "_#992 (stalled sub-issue of umbrella #984): 1 fork parked by cw-orchestrate._"

### Step 3: Ask, with the recommendation pre-filled

For **open questions**, ask each via `AskUserQuestion`, one question per turn. Lead with the planner's recommended answer as the first option marked "(Recommended)", then realistic alternatives, so the common case is a single tap. Frame options as outcomes, not implementation minutiae. Keep your own recommendation honest — if the planner didn't suggest one and you have a defensible view, offer it; if it's a genuine toss-up, say so.

For a **`## Decision needed`** (cw-review-residual), ask each decision the same way: the `decision_question` as the prompt, the recommended answer first ("(Recommended)"), then the alternatives. These are choices on already-shipped code, so frame them as outcomes ("show the banner once per session" vs "on every run"), not as code changes.

For a **stalled sub-issue** (`cw-status:stalled`), the fork is the text after `needs-input:` in the marker comment. Ask it via `AskUserQuestion` exactly like an open question: read the sub-issue body and its umbrella for context, form a defensible recommendation for the fork, lead with it marked "(Recommended)", then realistic alternatives. Frame options as outcomes (what the sub-issue should build), not implementation minutiae. The scan couldn't settle this fork headlessly; your answer is what makes the sub-issue plannable on the next scan.

Always allow **skip** — if the user isn't ready to decide an issue, leave it `cw-feedback:needs-input` and move on. Don't force an answer.

### Step 4: Write answers back into the body

For each answered issue, rewrite the parked block in place so the answers are unambiguous to the headless planner that re-reads it next run. Fetch, edit, push with `--body-file` (never hand-escape):

```sh
D="$(mktemp -d)"                                                  # scratch outside the checkout
gh issue view <n> --repo <repo> --json body -q .body > "$D/body.md"
# edit "$D/body.md"
gh issue edit <n> --repo <repo> --body-file "$D/body.md"
```

- **Open questions / Decision needed:** under each question or decision, add an `**Answer:** <decision>` line (and a one-line rationale if it matters for edge cases). Leave the questions visible so the trail is auditable.
- **Stalled sub-issue:** write the answer into the **sub-issue's own body** (its single source of truth — never mirror it onto the umbrella) by appending a `## Resolved fork` block that names the fork and the decision using the same `**Answer:**` convention, e.g.:

  ```markdown
  ## Resolved fork

  **Fork:** <the fork text from the marker comment>
  **Answer:** <your decision> — <one-line rationale if it matters for edge cases>
  ```

  This block is what the next cw-orchestrate scan reads (per [Step 3b](../cw-orchestrate/SKILL.md) / [readiness-sweep.md](../cw-orchestrate/references/readiness-sweep.md)) to route the sub-issue `route: ready` instead of re-parking the same fork. Do **not** delete or edit the `<!-- cw:status -->` marker comment yourself — removing the `cw-status:stalled` label (Step 5) is the release; the recorded answer on the body is what makes the fork resolved.

### Step 5: Release — flip the label to go, or remove the stalled label

Once an issue's answers are written, release it using that queue's mechanism:

```sh
# feedback issue — flip to :go:
gh issue edit <n> --repo <repo> --add-label cw-feedback:go --remove-label cw-feedback:needs-input
# cw-review-residual issue — flip to :go:
gh issue edit <n> --repo <repo> --add-label cw-review-residual:go --remove-label cw-review-residual:needs-input
# stalled sub-issue — just remove the stalled label (no :go flip):
gh issue edit <n> --repo <repo> --remove-label cw-status:stalled
```

For **feedback / cw-review-residual**, the `:go` label is what each loop's discovery query picks up; removing `:needs-input` keeps the inbox clean (a re-run of this skill won't re-ask an already-answered issue). Don't touch `cw-feedback:triaging` — the loop owns that.

For a **residual** whose decision was simply "accept current behavior / no change," there is nothing for the next sweep to build — you may instead close it directly with a one-line comment rather than flipping to `cw-review-residual:go`. Reserve `:go` for decisions that ask for a change the next sweep should apply.

For a **stalled sub-issue**, there is **no `:go` label** — the release is simply removing `cw-status:stalled`. Do **not** touch `cw-umbrella:needs-input` on the parent umbrella: cw-orchestrate's next repo scan runs a step-0 reconcile that detects the cleared park (the sub-issue no longer carries `cw-status:stalled`) and swaps the umbrella `cw-umbrella:needs-input` → `cw-umbrella:ready` on its own (`needsInputTerminalAction` → `'restore'` in [scheduler.mjs](../cw-orchestrate/scheduler.mjs)). Editing the umbrella label by hand would duplicate that live-state transition — leave it to the scan.

### Step 6: Offer to run the loop now

After clearing the batch, the cleared issues will be executed on the next scheduled tick. Offer to run it immediately instead (`AskUserQuestion`: "Run now on the N cleared issue(s)? / Wait for the next scheduled run"). Route to the right loop per queue:

- **feedback** issues → invoke `/cw-ship` (optionally `only: [<numbers>]`); it consumes `cw-feedback:go`.
- **cw-review-residual** issues → invoke `/cw-sweep`; it consumes `cw-review-residual:go` and applies the answered fixes.
- **stalled sub-issue parks** → invoke `/cw-orchestrate <repo>` (repo-scan mode); its step-0 reconcile restores the umbrella (`cw-umbrella:needs-input` → `cw-umbrella:ready`) and the same scan re-picks it, now routing the resolved sub-issue `route: ready` off the recorded-answer block.

If no, report which issues are now released (`:go`, or stalled-label removed) and that the schedule will pick them up.

### Step 7: Report

Summarize: issues released (cleared to `:go`, closed, or had `cw-status:stalled` removed) with the decisions made, issues skipped (still parked), split by queue (feedback vs cw-review-residual vs stalled sub-issue), and whether you kicked off a loop run. That's the whole job.

## Key Notes

- **Recommendation-first is the point.** Most parked questions should be a single tap because triage already proposed an answer. If you're routinely typing custom answers, the planner is under-deciding — that's worth noting back to the user, not just grinding through.
- **Skip is first-class.** Parking is async by design; the user answers when ready. Never pressure a decision or invent one to clear the queue.
- **Answers are data for a headless re-read.** Write them so the next triage planner can act with zero ambiguity. A vague "**Answer:** sure" re-parks; "**Answer:** show the banner once per session, keyed on the session id" gets built.
- **One go signal, owned by the user.** This skill is the *only* automated thing that adds `cw-feedback:go` / `cw-review-residual:go` — and it does so only after the user actually answered. Neither loop self-clears a park.
- **Holds are not parked questions.** `cw-feedback:hold` issues (cataloged but on hold) are *not* drained here — a held issue has no open questions to answer. Release a hold by hand-swapping `cw-feedback:hold` → `cw-feedback:new` (see the [cw-feedback skill](../cw-feedback/SKILL.md)), not through this inbox.
- **Stalled sub-issue parks are drained here now, and clearing one auto-unblocks its umbrella.** When cw-orchestrate's headless repo-scan hits a sub-issue it can't plan against, it parks that **sub-issue** with `cw-status:stalled` plus a `<!-- cw:status -->` marker comment (`⏸ needs-input: <fork>, parked for /cw-resolve`, not a `## Decision needed` body block), and if that leaves the umbrella with no runnable work it swaps the umbrella `cw-umbrella:ready` → `cw-umbrella:needs-input` so scans stop churning ([cw-orchestrate state machine](../cw-ship/references/state-machine.md)). This inbox now drains that queue too: answer the fork, record it on the **sub-issue body** under a `## Resolved fork` block (Step 4), then **release by removing `cw-status:stalled`** (Step 5) — there is no `:go` label for this kind. Do **not** touch `cw-umbrella:needs-input`: cw-orchestrate's next repo scan detects the cleared park and swaps the umbrella back to `cw-umbrella:ready` on its own (`needsInputTerminalAction` → `'restore'`), then re-picks it and routes the resolved sub-issue `route: ready` off the recorded answer. That closes the loop the "parked for /cw-resolve" comment promised.
- **Three queues, one habit.** Feedback, cw-review-residual, and stalled sub-issue parks land in the same inbox and clear the same way (read the parked question, answer with the recommendation pre-filled, record the answer, release). cw-sweep can also ask its own escalations inline during an interactive run, but anything left parked — by any loop — drains here.
- **`gh`/`git` via Bash**, not MCP — matches the rest of the pipeline.
