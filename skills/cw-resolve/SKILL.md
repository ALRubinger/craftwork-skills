---
name: cw-resolve
description: Resolve the parked decisions the autonomous loops couldn't make alone — both /cw-ship feedback (cw-feedback:needs-input) and /cw-sweep cw-review-residuals (cw-review-residual:needs-input). Find every parked issue, walk you through its open questions, proposed umbrella scope, or decisions one at a time with the recommended answer pre-filled, write your answers back into the issue body, and flip it to the matching :go label so the next loop run executes it autonomously. Trigger when the user wants to answer, clear, or review parked questions or decisions.
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

Answer the decisions that the autonomous loops parked for you. This is the operator's one routine inbox, and the only skill whose whole job is to take your input. It drains **two** parked queues with the identical recommendation-first flow:

- **Feedback** that `cw-ship` parked (`cw-feedback:needs-input`) — design forks and umbrella-scope approvals.
- **Review-residuals** that `cw-sweep` parked (`cw-review-residual:needs-input`) — judgment calls on shipped code that the residual triage couldn't auto-resolve.

This is the **third** skill in the feedback pipeline:

```
/cw-feedback        capture     → cw-feedback:new
/cw-ship plan + act  → auto-merge | PARK to body | umbrella
/cw-resolve  answer      → cw-feedback:go ──┐  (this skill)
       ▲                                     │
       └────────── next triage run ──────────┘
```

When the loop hits a genuine design fork — a question your original feedback didn't settle, or an umbrella-sized change needing scope approval — it writes the question into the issue body and flips the issue to `cw-feedback:needs-input` (the full contract is in [cw-ship's state machine](../cw-ship/references/state-machine.md)). This skill is how you clear those: it gathers them, asks you, records your answers, and adds `cw-feedback:go`. From there the loop is autonomous to merge — you never review the resulting PR. Answering here is the one routine action the pipeline asks of you.

## When to Use

When you want to drain the parked-decision inbox: "answer the feedback questions", "what's waiting on me", "go through the inbox", "decide the residual questions". Covers both parked feedback (`cw-feedback:needs-input`) and parked cw-review-residual decisions (`cw-review-residual:needs-input`). Often prompted by a push notification from a `/cw-ship` or `/cw-sweep` run that parked something. Do **not** use it to capture new feedback (`/cw-feedback`), to plan/execute feedback (`/cw-ship`), or to triage residuals (`/cw-sweep`).

## Prerequisites

- `gh` (authenticated — `gh auth status`) and `git`.
- Run from inside the target repo (or pass the repo) so detection works.
- The `AskUserQuestion` tool (load its schema via `ToolSearch` `select:AskUserQuestion` if needed).

## Workflow

### Step 0: Detect the repo

`git -C . remote get-url origin` → `owner/name`. If the cwd isn't the intended repo, ask which repo to drain.

### Step 1: Gather the parked issues

Gather both parked queues:

```sh
gh issue list --repo <repo> --state open --label cw-feedback:needs-input \
  --json number,title,body,url --limit 200
gh issue list --repo <repo> --state open --label cw-review-residual:needs-input \
  --json number,title,body,url --limit 200
```

If both are empty, say so plainly ("inbox empty — nothing parked") and stop. Otherwise process oldest-first (lowest number first) within each queue so the longest-waiting item clears first. Tell the user how many are parked, and of which kind, before you start. The two kinds differ only in the parked block they carry (Step 2) and the labels you flip (Step 5); the asking flow is identical.

### Step 2: Per issue — read the parked block

Each parked issue carries exactly one of:

- **`## Open questions`** (feedback) — a numbered list of design forks, each often with a recommended answer the planner suggested.
- **`## Proposed umbrella scope`** (feedback) — a title + why + a checklist of proposed sub-issues, for an umbrella-sized change awaiting your approval.
- **`## Decision needed`** (cw-review-residual) — a numbered list of judgment calls from residual triage, each with the question, a recommended answer, and the alternatives.

Read the whole body for context (for feedback: the Observation / What I want changed; for a residual: the finding and its rationale against the shipped code), then the parked block. Restate the issue to the user in one line before asking, so they have context: "_#137 (annoyance: launch banner repeats): 2 questions._" or "_#1010 (cw-review-residual for feature #984): 1 decision._"

### Step 3: Ask, with the recommendation pre-filled

For **open questions**, ask each via `AskUserQuestion`, one question per turn. Lead with the planner's recommended answer as the first option marked "(Recommended)", then realistic alternatives, so the common case is a single tap. Frame options as outcomes, not implementation minutiae. Keep your own recommendation honest — if the planner didn't suggest one and you have a defensible view, offer it; if it's a genuine toss-up, say so.

For a **proposed umbrella scope**, present the title + sub-issue list and ask: approve as-is (Recommended if it's sound) / edit the scope / not an umbrella — do it as a single PR instead / skip for now. If they choose edit, capture the edits (add/remove/retitle sub-issues) via follow-up questions or free text.

For a **`## Decision needed`** (cw-review-residual), ask each decision the same way: the `decision_question` as the prompt, the recommended answer first ("(Recommended)"), then the alternatives. These are choices on already-shipped code, so frame them as outcomes ("show the banner once per session" vs "on every run"), not as code changes.

Always allow **skip** — if the user isn't ready to decide an issue, leave it `cw-feedback:needs-input` and move on. Don't force an answer.

### Step 4: Write answers back into the body

For each answered issue, rewrite the parked block in place so the answers are unambiguous to the headless planner that re-reads it next run. Fetch, edit, push with `--body-file` (never hand-escape):

```sh
gh issue view <n> --repo <repo> --json body -q .body > body.md
# edit body.md
gh issue edit <n> --repo <repo> --body-file body.md
```

- **Open questions / Decision needed:** under each question or decision, add an `**Answer:** <decision>` line (and a one-line rationale if it matters for edge cases). Leave the questions visible so the trail is auditable.
- **Umbrella scope:** mark it `**Approved**` (or write the edited scope, or note "Resolved as single PR — not an umbrella" if they downgraded it).

### Step 5: Flip the label to go

Once an issue's answers are written, swap it to the cleared state using that queue's labels:

```sh
# feedback issue:
gh issue edit <n> --repo <repo> --add-label cw-feedback:go --remove-label cw-feedback:needs-input
# cw-review-residual issue:
gh issue edit <n> --repo <repo> --add-label cw-review-residual:go --remove-label cw-review-residual:needs-input
```

The `:go` label is what each loop's discovery query picks up; removing `:needs-input` keeps the inbox clean (a re-run of this skill won't re-ask an already-answered issue). Don't touch `cw-feedback:triaging` — the loop owns that.

For a residual whose decision was simply "accept current behavior / no change," there is nothing for the next sweep to build — you may instead close it directly with a one-line comment rather than flipping to `cw-review-residual:go`. Reserve `:go` for decisions that ask for a change the next sweep should apply.

### Step 6: Offer to run the loop now

After clearing the batch, the cleared issues will be executed on the next scheduled tick. Offer to run it immediately instead (`AskUserQuestion`: "Run now on the N cleared issue(s)? / Wait for the next scheduled run"). Route to the right loop per queue: invoke `/cw-ship` (optionally `only: [<numbers>]`) for cleared **feedback** issues, and `/cw-sweep` for cleared **cw-review-residual** issues (it consumes `cw-review-residual:go` and applies the answered fixes). If no, report which issues are now `:go` and that the schedule will pick them up.

### Step 7: Report

Summarize: issues cleared to `:go` or closed (with the decisions made), issues skipped (still `:needs-input`), split by queue (feedback vs cw-review-residual), and whether you kicked off a loop run. That's the whole job.

## Key Notes

- **Recommendation-first is the point.** Most parked questions should be a single tap because triage already proposed an answer. If you're routinely typing custom answers, the planner is under-deciding — that's worth noting back to the user, not just grinding through.
- **Skip is first-class.** Parking is async by design; the user answers when ready. Never pressure a decision or invent one to clear the queue.
- **Answers are data for a headless re-read.** Write them so the next triage planner can act with zero ambiguity. A vague "**Answer:** sure" re-parks; "**Answer:** show the banner once per session, keyed on the session id" gets built.
- **One go signal, owned by the user.** This skill is the *only* automated thing that adds `cw-feedback:go` / `cw-review-residual:go` — and it does so only after the user actually answered. Neither loop self-clears a park.
- **Holds are not parked questions.** `cw-feedback:hold` issues (cataloged but on hold) are *not* drained here — a held issue has no open questions to answer. Release a hold by hand-swapping `cw-feedback:hold` → `cw-feedback:new` (see the [cw-feedback skill](../cw-feedback/SKILL.md)), not through this inbox.
- **Two queues, one habit.** Feedback and cw-review-residual decisions land in the same inbox and clear the same way (read the parked block, answer, the label flips). cw-sweep can also ask its own escalations inline during an interactive run, but anything left parked — by either loop — drains here.
- **`gh`/`git` via Bash**, not MCP — matches the rest of the pipeline.
