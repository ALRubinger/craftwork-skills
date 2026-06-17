---
name: cw-resolve
description: Resolve the parked dogfooding-feedback issues that /cw-ship couldn't decide alone. Find every feedback:needs-input issue, walk you through its open questions (or a proposed umbrella scope) one at a time with the planner's recommended answer pre-filled, write your answers back into the issue body, and flip it to feedback:go so the next triage run executes it autonomously. Trigger when the user wants to answer, clear, or review parked feedback questions.
metadata:
  version: "0.1.0"
  triggers:
    - (answer|clear|resolve|review).?(the)?.?(parked|pending)?.?feedback
    - feedback.?inbox
    - (what'?s|whats).?(parked|waiting|blocked|pending).?(on)?.?feedback
    - feedback.?(needs.?input|questions)
    - go.?through.?(the)?.?feedback.?(questions|inbox)
---

# cw-resolve

Answer the feedback that `cw-ship` parked. This is the **third** skill in the feedback pipeline and the only one whose whole job is to take your input:

```
/cw-feedback        capture     → feedback:new
/cw-ship plan + act  → auto-merge | PARK to body | umbrella
/cw-resolve  answer      → feedback:go ──┐  (this skill)
       ▲                                     │
       └────────── next triage run ──────────┘
```

When the loop hits a genuine design fork — a question your original feedback didn't settle, or an umbrella-sized change needing scope approval — it writes the question into the issue body and flips the issue to `feedback:needs-input` (the full contract is in [cw-ship's state machine](../cw-ship/references/state-machine.md)). This skill is how you clear those: it gathers them, asks you, records your answers, and adds `feedback:go`. From there the loop is autonomous to merge — you never review the resulting PR. Answering here is the one routine action the pipeline asks of you.

## When to Use

When you want to drain the parked-feedback queue: "answer the feedback questions", "what's waiting on me", "go through the feedback inbox". Often prompted by a push notification from a triage run that parked something. Do **not** use it to capture new feedback (`/cw-feedback`) or to plan/execute (`/cw-ship`).

## Prerequisites

- `gh` (authenticated — `gh auth status`) and `git`.
- Run from inside the target repo (or pass the repo) so detection works.
- The `AskUserQuestion` tool (load its schema via `ToolSearch` `select:AskUserQuestion` if needed).

## Workflow

### Step 0: Detect the repo

`git -C . remote get-url origin` → `owner/name`. If the cwd isn't the intended repo, ask which repo to drain.

### Step 1: Gather the parked issues

```sh
gh issue list --repo <repo> --state open --label feedback:needs-input \
  --json number,title,body,url --limit 200
```

If none, say so plainly ("inbox empty — nothing parked") and stop. Otherwise process oldest-first (lowest number first) so the longest-waiting feedback clears first. Tell the user how many are parked before you start.

### Step 2: Per issue — read the parked block

Each parked issue carries exactly one of:

- **`## Open questions`** — a numbered list of design forks, each often with a recommended answer the planner suggested.
- **`## Proposed umbrella scope`** — a title + why + a checklist of proposed sub-issues, for an umbrella-sized change awaiting your approval.

Read the whole body for context (the Observation / What I want changed the feedback captured), then the parked block. Restate the issue to the user in one line before asking, so they have context: "_#137 (annoyance: launch banner repeats): 2 questions._"

### Step 3: Ask, with the recommendation pre-filled

For **open questions**, ask each via `AskUserQuestion`, one question per turn. Lead with the planner's recommended answer as the first option marked "(Recommended)", then realistic alternatives, so the common case is a single tap. Frame options as outcomes, not implementation minutiae. Keep your own recommendation honest — if the planner didn't suggest one and you have a defensible view, offer it; if it's a genuine toss-up, say so.

For a **proposed umbrella scope**, present the title + sub-issue list and ask: approve as-is (Recommended if it's sound) / edit the scope / not an umbrella — do it as a single PR instead / skip for now. If they choose edit, capture the edits (add/remove/retitle sub-issues) via follow-up questions or free text.

Always allow **skip** — if the user isn't ready to decide an issue, leave it `feedback:needs-input` and move on. Don't force an answer.

### Step 4: Write answers back into the body

For each answered issue, rewrite the parked block in place so the answers are unambiguous to the headless planner that re-reads it next run. Fetch, edit, push with `--body-file` (never hand-escape):

```sh
gh issue view <n> --repo <repo> --json body -q .body > body.md
# edit body.md
gh issue edit <n> --repo <repo> --body-file body.md
```

- **Open questions:** under each question, add an `**Answer:** <decision>` line (and a one-line rationale if it matters for edge cases). Leave the questions visible so the trail is auditable.
- **Umbrella scope:** mark it `**Approved**` (or write the edited scope, or note "Resolved as single PR — not an umbrella" if they downgraded it).

### Step 5: Flip the label to go

Once an issue's answers are written, swap it to the cleared state:

```sh
gh issue edit <n> --repo <repo> --add-label feedback:go --remove-label feedback:needs-input
```

`feedback:go` is what the loop's discovery query picks up; removing `feedback:needs-input` keeps the inbox clean (a re-run of this skill won't re-ask an already-answered issue). Don't touch `feedback:triaging` — the loop owns that.

### Step 6: Offer to run triage now

After clearing the batch, the cleared issues will be executed on the next scheduled `/cw-ship` tick. Offer to run it immediately instead (`AskUserQuestion`: "Run triage now on the N cleared issue(s)? / Wait for the next scheduled run"). If yes, invoke `/cw-ship` (optionally with `only: [<the cleared issue numbers>]` to act on just what you cleared). If no, report which issues are now `feedback:go` and that the schedule will pick them up.

### Step 7: Report

Summarize: issues cleared to `feedback:go` (with the decisions made), issues skipped (still `feedback:needs-input`), and whether you kicked off a triage run. That's the whole job.

## Key Notes

- **Recommendation-first is the point.** Most parked questions should be a single tap because triage already proposed an answer. If you're routinely typing custom answers, the planner is under-deciding — that's worth noting back to the user, not just grinding through.
- **Skip is first-class.** Parking is async by design; the user answers when ready. Never pressure a decision or invent one to clear the queue.
- **Answers are data for a headless re-read.** Write them so the next triage planner can act with zero ambiguity. A vague "**Answer:** sure" re-parks; "**Answer:** show the banner once per session, keyed on the session id" gets built.
- **One go signal, owned by the user.** This skill is the *only* automated thing that adds `feedback:go` — and it does so only after the user actually answered. The loop never self-clears a park.
- **`gh`/`git` via Bash**, not MCP — matches the rest of the pipeline.
