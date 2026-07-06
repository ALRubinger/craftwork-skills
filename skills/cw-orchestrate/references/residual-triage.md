# Residual Triage & Autofix

The plan-review stage (Stage 1.5) files a `cw-review-residual` issue per sub-issue: every non-trivially-auto-fixable finding it raised against the **plan**. Left alone these accumulate as a backlog of technical follow-ups. The triage + autofix roles clear them by re-judging each finding against the code that **actually shipped**, then acting on the cheap/clear ones and surfacing only genuine judgment calls.

This file is the **canonical, human-readable** statement of the two roles. `workflow.js` inlines string constants that mirror these (a Workflow script has no filesystem access at runtime). The pure decision logic lives in `triage.mjs` (tested) and is mirrored into `workflow.js`; `mirror.test.mjs` guards the drift.

The same two roles power the standalone `cw-sweep` skill, which runs them over an umbrella's existing open residuals (the backlog) instead of in-run.

---

## Why triage runs against shipped code, not the plan

A residual was written about a *plan*. By the time the sub-issue's PR merges, the implementation may have diverged from — or already fixed — the thing the residual flagged. So a finding is only meaningful once re-checked against the merged diff and the current files on the default branch. This is why triage cannot run at review time: there is no shipped code yet. It runs:

- **In-run**, the moment a node merges (cw-orchestrate) — the node's residual is re-judged against its just-merged diff while later nodes are still being worked. Inputs are clean: the sub-issue is a real feature and the merged PR URL is in hand.
- **Out-of-run**, over the backlog (`cw-sweep` skill) — discovers open residuals and triages each against the current state of the default branch. Two backlog realities the standalone skill handles that the in-run path never sees:
  - **Nested residual chains.** A later run may adopt an older residual as a sub-issue, so a newer residual reads `Relates to #<another-residual>`. Discovery follows the chain (each residual's title is `plan findings for #<n>`) down to the underlying **feature** and triages against *its* code.
  - **No closing-PR link.** An issue closed without a `Closes #` keyword has no `closedByPullRequestsReferences`. "No link" is not "unshipped" — triage falls back to searching merged PRs and the merge-commit log, and ultimately judges against the **files at default-branch HEAD**, which are the ground truth regardless of which PR landed them.

A residual is marked `shipped:false` and deferred **only** when the feature is genuinely not on the default branch — open/halted, no merged PR or merge commit references it, and its code is absent at HEAD (e.g. a P0-halted feature). Missing metadata alone never causes a deferral.

---

## Triage role

**Purpose:** Re-judge one residual's findings against the shipped code; close what is resolved or moot; classify the rest.

**Inputs:** the residual issue URL and the underlying feature issue number. In-run, the merged PR URL is also passed. Out-of-run, the subagent establishes "has this shipped?" itself (closing-PR link → merged-PR/merge-commit search → presence at HEAD) and judges findings against the files at default-branch HEAD, using any merged PR diffs as supporting context.

**Per-finding verdict** (judged against the merged diff + current files):

| Verdict | Meaning | Action |
|---|---|---|
| `RESOLVED` | The shipped code already does the right thing (cite file/line). | none |
| `FIX_NOW` | A real, small, unambiguous fix. | `confidence: high` → auto-fixed & merged with no human review; `confidence: low` → escalate |
| `DECISION` | Needs a human judgment call (a real trade-off or unclear-correct fix). | escalate |
| `MOOT` | The finding was wrong or the implementation diverged so it no longer applies. | none |

**Confidence is the safety gate.** `high` means the fix will be applied and merged unsupervised, so it is reserved for fixes the classifier is sure are correct, safe, and in-scope. Any ambiguity → `low` → it becomes a human escalation rather than auto-applied. Auto-merging a wrong fix is worse than leaving a residual open.

**Actions the triage subagent takes itself:**

1. Post one triage comment on the residual summarizing each finding's verdict + one-line rationale.
2. Close the residual **only** when every finding is `RESOLVED` or `MOOT` (nothing actionable remains). Otherwise leave it open.

**Output schema (`TRIAGE_SCHEMA`):**

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["residual_issue", "sub_issue", "shipped", "closed", "findings"],
  "properties": {
    "residual_issue": { "type": "integer" },
    "sub_issue":      { "type": "integer" },
    "shipped":        { "type": "boolean" },
    "closed":         { "type": "boolean" },
    "findings": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["title", "verdict"],
        "properties": {
          "title":      { "type": "string", "minLength": 1 },
          "severity":   { "type": "string", "enum": ["P0", "P1", "P2"] },
          "verdict":    { "type": "string", "enum": ["RESOLVED", "FIX_NOW", "DECISION", "MOOT"] },
          "confidence": { "type": "string", "enum": ["high", "low"] },
          "rationale":  { "type": "string" },
          "fix_hint":   { "type": ["string", "null"] },
          "decision_question":  { "type": ["string", "null"] },
          "recommended_answer": { "type": ["string", "null"] },
          "alt_options":        { "type": "array", "items": { "type": "string" } }
        }
      }
    }
  }
}
```

---

## Disposition (pure, from `triage.mjs`)

`closeDisposition(result)` derives what happens to each residual purely from its findings:

- **`close-now`** — every finding `RESOLVED`/`MOOT`. The triage subagent closes it.
- **`close-via-autofix`** — only `RESOLVED`/`MOOT` + high-confidence `FIX_NOW` remain. The autofix PR carries `Closes #<residual>` **only if it applies every listed fix**; if it must skip one (too large/ambiguous — recorded in `skipped_fixes`), it downgrades to `Relates to #<residual>` and the residual stays open for the next sweep, so a skipped fix never closes the residual having dropped real work.
- **`keep-open`** — at least one `DECISION` or low-confidence `FIX_NOW` remains. A human (or the standalone skill's autofix on a re-run) must finish it; an autofix PR here only `Relates to` the residual.

`autofixCandidates(results)` → residual numbers with ≥1 high-confidence `FIX_NOW` (the autofix queue). `escalations(results)` → every `DECISION` plus every low-confidence `FIX_NOW` **on shipped residuals** (what reaches the human), each carrying its `decision_question` / `recommended_answer` / `alt_options` so it can be asked or parked verbatim. `parkCandidates(results)` → shipped residual numbers carrying ≥1 such judgment call (the park queue, the headless analog of `autofixCandidates`). `deferredResiduals(results)` → residuals whose sub-issue had not shipped (excluded from escalations — a deferral is not a decision).

---

## Autofix role

**Purpose:** Implement the high-confidence `FIX_NOW` findings for one residual, in isolation, as one PR — then return for serial merge.

**When it runs:** a **final sweep**, after every feature node has merged or stalled and the default branch is quiescent. Running here (not interleaved per-node) is deliberate: nothing else is merging, so a residual fix cannot collide with an unmerged sibling that the per-node schedule never accounted for.

**Dispatch:** `agent(autofixPrompt(node), { isolation: 'worktree', schema: BUILD_SCHEMA, phase: 'Autofix' })`, one per `autofixCandidates` entry, sequential. The subagent receives **only** the high-confidence fixes (`highConfidenceFixes(result)`) and is instructed to stay strictly in scope — a fix that turns out larger or ambiguous than described is skipped and recorded in `skipped_fixes`, never expanded.

**Freshness pre-check (first, before branching).** The triage snapshot can go stale between classification and implementation — a parallel PR or another session may close the residual or land an equivalent fix on the default branch. So the subagent re-verifies before writing code: (a) the residual is still **open** (else stop, `ready_to_merge:false`, cause "already closed since triage"), and (b) each listed fix is **not already present** at fresh default-branch HEAD (drop those that are; if all are, stop with cause "fixes already landed"). This is what keeps the out-of-band `cw-sweep` backlog drain — where snapshots are oldest and parallel work likeliest — from burning a PR + CI cycle re-implementing work that already merged. The in-run path triages right after each node merges, so its window is smaller, but the same guard applies.

**Closing keyword** is set from the disposition *and* whether every fix actually landed: `close-via-autofix` **with all fixes applied** → `Closes #<residual>`; `close-via-autofix` **but any fix skipped** (`skipped_fixes` non-empty) → `Relates to #<residual>`, residual stays open; any other disposition → `Relates to #<residual>` (unresolved escalations remain). The subagent reports skipped fixes in `skipped_fixes`, so the report can tell "closed, all applied" from "kept-open, some skipped".

**Output schema:** the same `BUILD_SCHEMA` the work role returns, so the autofix PR flows through the identical serialized merge step (`mergePrompt` / `MERGE_SCHEMA`, see `merge-safety.md`). `issue` carries the residual number for logging.

---

## The decision park/resolve/go loop (cw-sweep)

The standalone `cw-sweep` skill routes escalations to the operator through the same label state machine the feedback pipeline uses (`cw-ship`'s `state-machine.md`), so judgment calls do not evaporate into an unread headless log:

- **Park.** After triage + autofix, each `parkCandidates` residual gets a `## Decision needed` block written into its body (one entry per judgment call: the `decision_question`, the `recommended_answer`, the `alt_options`) and the `cw-review-residual:needs-input` label. Unshipped residuals defer instead of parking.
- **Resolve.** The operator answers — inline during an interactive `cw-sweep` run (it asks each decision through the harness's blocking-question UI when available, or direct chat otherwise, recommendation first), or later via the `cw-resolve` skill, which drains `cw-review-residual:needs-input` the same way it drains `cw-feedback:needs-input`. An `**Answer:**` line goes under each decision and the label flips to `cw-review-residual:go` (or the residual is closed if the answer is "accept / no change").
- **Go / consume.** Discovery classifies each residual's `human_state` from its labels: `needs-input` residuals are **skipped** (still awaiting the operator), `go` residuals are triaged in **consume mode** — the subagent reads the operator's answers and re-classifies (accept → `RESOLVED`; a **small, bounded** "do X" → high-confidence `FIX_NOW`), so the normal autofix/close machinery applies the decision. A `go` answer that authorizes a **feature-sized or broad** change is deliberately **not** high-confidence: it would route to close-via-autofix, where the autofix subagent skips the over-large fix and the residual would close having dropped the answered decision. Such answers stay `DECISION` and **re-park** (label flips back to `cw-review-residual:needs-input`, breaking the go → skip → never-close loop), carrying a `decision_question` that routes the authorized-but-large change (scope into an umbrella with the cw-scope skill, or escalate). (This qualification is cw-sweep-only; the in-run cw-orchestrate path does not consume operator answers.)

The same `decision_question` / `recommended_answer` / `alt_options` fields feed both the inline question and the parked block, so the recommendation is authored once. The in-run cw-orchestrate path **also parks**, exactly as cw-sweep does: its Park phase (after Autofix) writes the same `## Decision needed` block + `cw-review-residual:needs-input` label onto each `parkCandidates` residual, so a standalone the `cw-resolve` skill (which queries `--label cw-review-residual:needs-input`) discovers and drains the in-run judgment calls instead of having them visible only in the umbrella report. The report still carries `escalations` for the operator surfacing it inline; the park is the durable copy, not a replacement. Unshipped residuals defer (`deferred_residuals`) rather than park.

---

## Report fields

The Workflow report gains:

```json
{
  "triaged":  [{ "residual_issue": 1000, "sub_issue": 986, "shipped": true, "closed": true, "disposition": "close-now" }],
  "autofixed": [{ "residual_issue": 992, "pr": "https://.../pull/NNN", "merged": true, "cause": null, "skipped_fixes": [], "residual_closed": true }],
  "parked": [1010],
  "escalations": [{ "residual_issue": 1010, "sub_issue": 984, "title": "...", "verdict": "DECISION", "confidence": null, "rationale": "...", "decision_question": "...", "recommended_answer": "...", "alt_options": ["..."] }],
  "awaiting_input": [1004],
  "deferred_residuals": [1011]
}
```

`escalations` is what needs a human after a run: genuine judgment calls and low-confidence fixes, each parked to its residual (`parked`) for the operator to answer inline or via the `cw-resolve` skill. `awaiting_input` are residuals parked in a prior run still waiting on the operator (skipped this run). `deferred_residuals` are residuals whose feature had not shipped yet (re-triage on a later run).
