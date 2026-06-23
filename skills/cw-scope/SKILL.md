---
name: cw-scope
description: Turn a rough initiative into an execution-ready GitHub umbrella issue — interactively brainstorm the why, resolve every plan-blocking decision, scope the work into orchestrate-able sub-issues, and emit the umbrella + sub-issues on GitHub rich enough that /cw-orchestrate's readiness sweep finds nothing to investigate. Trigger when the user wants to create, scope, plan, or spec an umbrella/tracking/parent issue (the front-end to cw-orchestrate).
metadata:
  version: "0.1.0"
  triggers:
    - create.?(an?|the)?.?umbrella
    - (scope|spec|plan).?(an?|the)?.?(umbrella|tracking|parent).?issue
    - turn.?this.?into.?(an?)?.?umbrella
    - break.?(this|it).?into.?sub.?issues
    - make.?(an?|the)?.?umbrella.?(issue)?.?(for)?
---

# cw-scope

Turn a rough initiative into an **execution-ready** GitHub umbrella issue.

This skill is the **front-end** to [`cw-orchestrate`](../cw-orchestrate/SKILL.md). Where cw-orchestrate takes a ready umbrella from "open sub-issues" to "merged PRs" hands-off, cw-scope *produces* that umbrella: it runs the brainstorm-and-preflight motion interactively, then writes a GitHub umbrella issue plus sub-issues whose bodies are complete enough that cw-orchestrate's readiness sweep routes **every** sub-issue `ready` — no clarify-now, no back-off, no invention.

The two skills share a vocabulary on purpose. cw-scope front-loads, into the GitHub issue bodies, exactly the judgment the orchestrate sweep would otherwise have to extract from the operator: resolved decisions, repo-family constraints, file pointers, acceptance, and logical dependency edges. The sweep then becomes a confirmation pass, not an investigation.

## When to Use

Use when the user points at an initiative — a feature, a refactor, a descope, a migration — and wants it turned into a structured umbrella issue ready for batch execution. Triggers: "create an umbrella for X", "scope this into sub-issues", "spec out removing Y and set it up for orchestrate".

Do **not** use for:
- A single, self-contained change (just plan + work it directly).
- Pure product discovery with no implementation shape yet (use a brainstorm skill first, then come here with the decisions).
- Executing an existing umbrella (that is `cw-orchestrate`).

## The seam (who owns what)

| Artifact | Owner |
|----------|-------|
| Human-durable **why + resolved decisions**, in the **umbrella + sub-issue bodies on GitHub** | **cw-scope** (this skill) |
| Per-run readiness **briefs** + **manifest** (the headless handoff) | cw-orchestrate's sweep |
| Plans, file-ownership, schedule, merges | cw-orchestrate's background Workflow |

This skill does **not** write briefs or a manifest. It makes the GitHub bodies so complete that brief-writing during the sweep is mechanical. The sweep stays the safety gate; this skill's job is to make it boring.

## Prerequisites

- `gh` (GitHub CLI) — verify `gh auth status`.
- `git` — run from inside the target repo (or a worktree of it) so repo-instruction files and code are readable.
- Read access to the repo's `CLAUDE.md` / `AGENTS.md` (and `STRATEGY.md` / `CONCEPTS.md` if present) — their constraints get baked into sub-issue bodies.

## Reference files

- [references/decision-preflight.md](./references/decision-preflight.md) — how to find and resolve the plan-blocking forks so the sweep routes everything `ready`. This is the heart of the skill.
- [references/issue-templates.md](./references/issue-templates.md) — the umbrella-body and sub-issue-body shapes, plus the GitHub creation recipe (convention detection, placeholder backfill, parent linkage). Also documents the **`integration/<slug>` integration-branch targeting** convention (the `cw-target:<slug>` label and how the branch name derives from it).

The skill is executable from `SKILL.md` alone; the references carry detail.

## The bar

A sub-issue is done being written when an `cw-orchestrate` readiness sweep reading its body would route it **ready** — not `clarify-now` (a plan-blocking question remains) and not `back-off-to-brainstorm` (a user-facing behavior or scope boundary is undecided). If you cannot get a sub-issue to `ready`, the gap is a decision the user must make now (resolve it in Step 3) or genuine product ambiguity (the initiative isn't ready for an umbrella — say so).

## Workflow

### Step 0: Load repository instructions and the target parent

Search the target repo for `CLAUDE.md` / `AGENTS.md` (and `STRATEGY.md` / `CONCEPTS.md`). Extract the constraints that any sub-issue plan must honor — these get copied into every sub-issue's **Constraints** section so the headless planner inherits them. Typical repo-family constraints: spec-is-source-of-truth + regen step, approval-gating ADR, idempotency-flag ADR, conventional commits, squash-merge, coverage bar, docs writing voice, no-backwards-compat.

If the umbrella will be a **child** of an existing parent (e.g. a milestone issue), read the parent now (`gh issue view <parent> --json body,subIssues`) and note **how it links its children** — native sub-issues vs. a body checklist of `#NNN` references. Mirror that convention when linking the umbrella *up* into the parent (Step 6). (This detection is for the up-link only; the umbrella's own sub-issues are always native — see Step 6.)

### Step 1: Frame the why (interactive)

Elicit the initiative's motivation with the user, one question at a time, using the platform blocking-question tool (`AskUserQuestion`; load its schema via `ToolSearch` with `select:AskUserQuestion` if needed). Capture:

- **The problem** — what's wrong or missing, in the user's framing.
- **The motivation** — why now, what value, what it unblocks. This becomes the umbrella's human-centric "Why".
- **Scope intent** — what's explicitly in, and what's explicitly out / deferred.

Keep this tight. The goal is a "Why" paragraph a teammate could read cold and understand the initiative.

### Step 2: Scan the surface

Before scoping, map the real footprint so sub-issues cut along true seams, not guessed ones:

- Grep/read the repo for everything the initiative touches. Categorize by kind (e.g. code / API spec / ADRs / docs / tests / tracking) and by file, with rough magnitudes.
- **Verify every claim against the code.** "X doesn't exist", "Y is only referenced in comments", "the spec mentions Z" — confirm by reading. The sub-issue bodies will assert these; a wrong assertion sends a headless planner down a dead end.
- Note any source-of-truth surfaces (e.g. an OpenAPI spec) that force a spec-first ordering or a regeneration step.

### Step 3: Resolve the forks (interactive — the core)

This is where the skill earns its keep. Follow [references/decision-preflight.md](./references/decision-preflight.md):

- Identify every **plan-blocking** decision — a fork where a headless planner would otherwise pick something and the user should decide instead. Depth/approach, naming, exact user-facing strings (error messages, flags), what to keep vs. remove, idempotency/approval posture for new write surfaces, migration safety.
- Resolve each with the user via `AskUserQuestion`, one question per turn. Lead with a recommended option when you have one.
- **Mint exact strings now.** If the work introduces a user-facing message, flag, or enum value, decide the literal text here so every downstream sub-issue (code, ADRs, docs) quotes it verbatim. Divergent wording across issues is a classic sweep snag.

Do not ask questions a planner can reasonably decide on its own — those are noise. Ask only the forks whose answers change what gets built.

### Step 4: Scope into sub-issues

Cut the work into sub-issues at **one-orchestrate-able-PR** granularity — each independently plannable, implementable, and squash-mergeable. For each sub-issue, draft a body per the [sub-issue template](./references/issue-templates.md): **What this is**, **Resolved decisions** (from Step 3), **Constraints** (from Step 0), **Pointers** (repo-relative files / ADRs / prior PRs to mirror), **Acceptance** (including required regression tests).

Run the **completeness check** on each draft: read it as if you were the headless planner and name anything you'd have to invent. Close every such gap with the user, or record it explicitly as an accepted gap. No sub-issue ships carrying a silent assumption.

Run the **self-containment check** alongside it: a fresh session must be able to plan the sub-issue from its body plus the **committed** repo alone. A **Pointers** entry is valid only if it resolves on the default branch — a repo-relative file, a merged ADR, a landed PR. An uncommitted `ce-brainstorm` requirements doc, a scratch path, or any local-only artifact is **not** a pointer: inline its resolved decisions (with their requirement numbers and text if you cite them by number) into **Resolved decisions** and reference nothing. If decisions came from a brainstorm, the brainstorm doc stays private scratch — neither committed nor cited. The bar is the same one orchestrate's sweep enforces: a body that points at something the sweep can't open is not `ready`.

### Step 5: Declare dependencies

With the user, declare **logical** dependency edges between sub-issues — "B's implementation needs A's merged code", independent of file overlap. State them as `depends_on` in the umbrella body so the orchestrate sweep confirms rather than derives. Validate the edges form a DAG; reject cycles. (File-contention ordering is computed later by orchestrate from plan ownership tables — do not declare it here.)

### Step 6: Emit on GitHub (confirm first)

This is the last human checkpoint before writing to shared state. Show the user the umbrella body, the sub-issue list with titles, and the dependency edges, and get an explicit go (`AskUserQuestion`).

Then create the issues per the [creation recipe](./references/issue-templates.md):

1. Create the **umbrella** first; its body carries placeholder `#__SUBn__` tokens only in the dependencies section — there is no sub-issue checklist.
2. Create each **sub-issue** (body references the umbrella as `Parent: #<umbrella>` and any decided cross-issue links via placeholder).
3. **Link each sub-issue to the umbrella as a native sub-issue** (`addSubIssue` GraphQL mutation, in reading order) — this *is* the parent↔child relationship.
4. **Backfill** the real numbers: replace `#__SUBn__` placeholders in the umbrella's dependencies section and any cross-referencing sub-issue, then `gh issue edit --body-file` each corrected body.
5. **Link the umbrella up to its own parent** (if any), mirroring the parent's convention from Step 0: a `- [ ]` line into a human milestone you don't own, or another `addSubIssue` if that parent itself uses native sub-issues.

Always use `--body-file` (or a quoted heredoc) — never hand-escape backticks.

### Step 6.5: Offer integration-branch targeting (optional, opt-in)

Now that the umbrella exists as a real issue number, **offer** — do not default — to mark it as an integration-branch target. This is purely additive: **absent the label, scope and downstream orchestrate behavior are byte-identical to today.** Decline leaves the flow unchanged.

Ask via `AskUserQuestion` whether this initiative should land on a shared integration branch (recommend it when the umbrella's sub-issues build on each other toward one cohesive feature; skip it for independent one-off fixes). On accept:

1. **Derive a git-ref-safe slug.** The slug is the suffix of both the label `cw-target:<slug>` and the branch `integration/<slug>`, so it must be a valid git ref segment: lowercase, hyphen-separated, no spaces or slashes. (Example: slug `integration-targeting` → label `cw-target:integration-targeting`, branch `integration/integration-targeting`.)
2. **Create the label** (idempotent — if it already exists, skip or update its description), putting the human-readable note in the **label description**:
   ```bash
   gh label create "cw-target:<slug>" --description "<human note>" \
     || gh label edit "cw-target:<slug>" --description "<human note>"
   ```
3. **Apply it to the umbrella:**
   ```bash
   gh issue edit "$UMB" --add-label "cw-target:<slug>"
   ```

The label on the umbrella is the **single source of truth** for the target — it both declares the target *and* is the grouping key. **Write nothing into the issue body** (no body field, no duplicated state). The branch `integration/<slug>` is **derived deterministically** from the slug — never stored separately. **Sub-issues inherit** the target from the umbrella's label; do **not** add per-sub-issue labels.

See the [integration-branch targeting section](./references/issue-templates.md#integration-branch-targeting-cw-targetslug) for the full convention.

### Step 7: Handoff

Report the created tree (umbrella + sub-issues, with links) and print the exact next invocation: `/cw-orchestrate <umbrella-number>` (optionally with `--only <n>` for a de-risked first run on a dependency-free sub-issue).

If this initiative changed a decision recorded in durable memory (e.g. a default that this umbrella reverses), update that memory so it reflects the new state — the umbrella is now the source of truth for the change.

## Key Notes

- **The output is the umbrella, not a plan.** This skill resolves *what* and *why* and structures it; *how* is the planner's job (orchestrate's Workflow). Keep implementation design out of sub-issue bodies except where a decision is itself the point (a kept abstraction seam, a spec-first ordering, a decided error string).
- **Route-to-ready is the contract.** Every sub-issue body must be complete enough that orchestrate's sweep routes it `ready`. That is the single quality bar.
- **Self-contained or it isn't ready.** A body that leans on an uncommitted brainstorm doc, a scratch file, or any artifact the sweep can't open is `clarify-now`, not `ready` — inline the decisions, cite nothing local (Step 4). Pointers are for things on the default branch (repo files, merged ADRs, landed PRs) only.
- **Mirror orchestrate's vocabulary** — `ready` / `clarify-now` / `back-off`, readiness brief, `depends_on`, DAG — so the two skills compose without translation.
- **Own sub-issues are always native; mirror only the *up*-link.** A cw-skill umbrella tracks its own children as GitHub native sub-issues, full stop — no body checklist, no duplicated title list. The detect-and-match rule applies only to linking the umbrella *up* into a parent you don't own: don't impose native sub-issues on a human milestone that tracks children by body checklist (or vice versa).
- **`gh`/`git` via Bash**, not MCP — matches orchestrate and survives headless contexts.
- **Confirm before creating.** Issue creation is shared-state; Step 6 is the gate.
- **Integration targeting is an offer, not a default.** The `cw-target:<slug>` label on the umbrella is the single source of truth for the target (no body field, no per-sub-issue labels); the branch `integration/<slug>` derives from the slug. Absent the label, scope and orchestrate behavior are unchanged — Step 6.5 only ever adds.
- **Interactive by design.** No background Workflow — the value is the human-in-the-loop decision resolution that makes the downstream run hands-off.
