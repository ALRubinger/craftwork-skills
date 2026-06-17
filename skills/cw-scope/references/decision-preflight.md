# Decision Preflight

The reason `cw-orchestrate` needs an interactive readiness sweep is that issue bodies usually carry the *what* but not the *decisions*. A headless planner handed an under-decided issue fills the gaps by invention. This skill's core job is to make those decisions **with the user, up front**, and write them into the issue bodies so the sweep finds nothing left to decide.

## What counts as a plan-blocking decision

A fork is plan-blocking when a planner *would have to choose* and the choice changes what gets built or how a user experiences it. Resolve these with the user. Common kinds:

- **Depth / approach.** How far does the change cut? (e.g. "strip the supported surfaces but keep the abstraction seam" vs. "rip the abstraction out entirely".) The wrong default here is expensive to undo.
- **Keep vs. remove.** When removing something, what stays? Name the seam, interface, or behavior that is deliberately preserved, and why.
- **Exact user-facing strings.** Error messages, CLI flag names and help text, enum values, status text. Decide the **literal** text once so every downstream issue quotes it verbatim.
- **Write-surface posture.** A new endpoint/command that mutates state: is it idempotent? Does it need approval gating? In repo families with ADRs governing these (e.g. approval-gating, idempotency-flag), a planner inventing the posture silently is a real risk — pin it.
- **Naming.** New commands, files, packages, config keys — if the name is load-bearing or user-visible, decide it.
- **Migration / safety.** Data migrations, breaking changes, deploy-window constraints. Decide the safe path, not the planner.
- **Source-of-truth ordering.** If a generated artifact has a hand-authored source (an OpenAPI spec, a schema), the decision is "edit source then regenerate" — state it as a constraint and name the regen command.

## What is NOT plan-blocking (don't ask)

A planner can reasonably decide these on its own; asking is noise:

- Internal helper names, private function structure, file-internal organization.
- Test framework mechanics (which already follow repo convention).
- Obvious error handling that follows an established repo pattern.
- Formatting, import order, anything a linter governs.

When unsure whether a fork is plan-blocking, ask: *if two competent planners resolved this differently, would the user care which they got?* If yes, it's plan-blocking.

## How to resolve

- One question per turn, via the platform blocking-question tool (`AskUserQuestion`).
- Lead with a **recommended** option when you have a defensible one (mark it "(Recommended)"), then the alternatives. The user can always redirect.
- Frame options as **mechanism / outcome** distinctions, not implementation minutiae — the user is deciding product/scope shape, not writing code.
- Capture the answer **and the rationale** in the sub-issue's Resolved decisions section. The rationale lets a planner handle edge cases the decision didn't literally cover.

## Mint exact strings, once

If the work introduces or changes any literal a user or another file will reproduce — an error message, a flag, an enum, a status string — decide its exact text during preflight and record it verbatim. Then:

- The code sub-issue implements that exact string.
- The docs sub-issue documents that exact string.
- The ADR sub-issue (if any) quotes that exact string.

Divergent wording across sibling issues is one of the most common reasons a sweep stops to clarify. Eliminate it here.

## The completeness check (per sub-issue)

Before a sub-issue is done, read its body as if you were the context-free headless planner and ask: *what would I have to invent to produce a plan from this?* For each gap:

- An unstated default → decide it (or record it as an explicitly accepted gap).
- An undecided boundary → resolve it with the user.
- An ambiguous term → define it, mapping to repo `CONCEPTS.md` vocabulary if present.
- A missing constraint → pull it from `CLAUDE.md` / `AGENTS.md` into the Constraints section.
- "The existing pattern" with no file named → name the file in Pointers.

A sub-issue passes when it carries no silent assumption — every gap is either closed or explicitly accepted. That is the same gate orchestrate's sweep runs; running it here, with the user present, is what lets the sweep route the issue `ready`.
