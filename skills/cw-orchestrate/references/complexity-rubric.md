# Complexity Rubric — Model Routing for Build/Review/Autofix Agents

Shared by **cw-orchestrate** and **cw-ship**: both workflows' Fable-pinned plan
prompts cite this rubric when judging an issue's complexity and emitting the
`routing` block that steers every downstream build/autofix agent. This file is
the human-readable source of truth; the plan prompts inline the operative rules
(a subagent runs in the *target* repo and cannot read this file at runtime).

## The contract

Planning and plan-review are **pinned to Fable** (`model: 'fable'` on the
`agent()` call) so planning quality never depends on the operator's session
model. The Fable plan step then judges the issue against this rubric and emits:

```json
{
  "routing": {
    "provider": "claude",
    "model": "fable" | "opus" | "sonnet" | "haiku",
    "effort": "low" | "medium" | "high" | "xhigh" | "max",
    "complexity": "mechanical" | "standard" | "complex",
    "rationale": "one line citing the evidence"
  }
}
```

The workflow passes `model` + `effort` into the build agent's `agent()` opts
(cw-orchestrate's Work-phase work agents and Autofix agents; cw-ship's build
agent). Dispatch is `routedAgentOpts()` (canonical in each skill's
`routing.mjs`, mirrored in `workflow.js`).

## Quality-matching bias: route UP when uncertain

The driver is **quality matching, not cost**: hard issues deserve top-tier
building; mechanical issues don't need it. Cost savings are incidental — never
the deciding factor.

| complexity | evidence | model |
| --- | --- | --- |
| `complex` | cross-cutting design, subtle concurrency/correctness, security-sensitive surface, ambiguous acceptance criteria | `fable` (or `opus` at `xhigh`/`max`) |
| `standard` | a normal bounded feature or fix — **the default when uncertain** | `opus` |
| `mechanical` | POSITIVE evidence of pattern-following work with no design judgment: a rename, a config/version bump, a doc tweak, a golden regen | `haiku`/`sonnet` allowed — or `opus` at `low` effort |

- **Opus is the default.** `haiku`/`sonnet` require positive evidence of
  mechanical work; absence of evidence of difficulty is NOT evidence of
  mechanical work.
- **Effort is a second dial.** Prefer routing the model UP and the effort DOWN
  over dropping a tier: `opus` at `low` effort is a valid route for mechanical
  work.

## Operator override: escalate-only floor

An explicit `Routing: <tier>` line in the issue body (e.g. under Resolved
decisions: `Routing: opus`) is a **floor, never a ceiling**: the planner may
route above it, never below it.

Routing is never mandatorily written back to issues. The run-time
recommendation lives **only** in run artifacts (the plan's structured output)
and workflow `log()` output — no mirrored state on GitHub.

## Reviewer floor

A reviewer never runs on a lower tier than the builder it reviews. This is
structurally satisfied in v1: diff review is the builder's self-review (same
agent, same model) and plan review is pinned to Fable (the top tier). Any
future standalone reviewer must inherit at least the builder's routed tier.

## Provider seam: open enum, Claude-only execution

`provider` is an **open enum** (any string) so a future codex/GPT route can
slot in without a schema redesign, but **v1 executes Claude tiers only**:
`routedAgentOpts()` honors the routed model only when `provider` is `"claude"`
and `model` is one of `fable | opus | sonnet | haiku` (the values Workflow
`agent()` `opts.model` accepts); anything else defaults **up** to `opus`.
The same default-up applies when routing is unavailable altogether (e.g. an
autofix whose parent node's plan is missing).
