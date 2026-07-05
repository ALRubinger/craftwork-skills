# Readiness Sweep

The sweep is the cw-orchestrate mechanism's **single human touchpoint** (R4). It runs interactively in the main session, before any plan exists, and front-loads the judgment the downstream hands-off Workflow can't supply. Its output is a routed list of sub-issues plus a per-issue **readiness brief** and a set of declared dependency edges — together the manifest the Workflow consumes.

The sweep's real job: make each brief **complete enough that headless planning needs no further human input**. A thin brief means the planner fills gaps by invention; the sweep exists to prevent that.

Scope is resolved before routing: if the invocation used `--only` / `--except` (SKILL.md Step 1), the sweep runs over the filtered in-scope set only, and out-of-scope `depends_on` edges are pruned with an explicit operator warning (SKILL.md Step 3).

## Two gate postures

cw-orchestrate has two entry paths, and they place the single clearance gate at **different points** — but neither ever plans against an unresolved fork. (That clearance is a human approval for cw-scope umbrellas and the interactive number-mode sweep; for a cw-ship umbrella it is the autonomous triage judgment the `cw-umbrella:ready` label encodes — a genuine fork parks upstream rather than producing an umbrella.)

| Entry | Human gate | Sweep? |
|-------|-----------|--------|
| **Number mode** (`/cw-orchestrate <umbrella>`) | **At the sweep** — the interactive readiness sweep below is the single human touchpoint. | Yes, full interactive sweep. |
| **Repo-scan mode** (`/cw-orchestrate <owner>/<repo>`) | **Upstream, at label-stamp time** — the `cw-umbrella:ready` label already encodes upstream clearance (cw-scope: interactive human scoping; cw-ship: an autonomous triage judgment that the feedback was umbrella-sized with clear intent and no unsettled design fork — a genuine fork would have parked as `cw-feedback:needs-input` instead of producing an umbrella). | **No.** It runs headless and cannot solicit a human. |

Repo-scan mode runs **no interactive sweep**: it trusts the upstream clearance the label encodes. But it still performs the sweep's *routing judgment* — headlessly (SKILL.md, Repo-scan mode / Step 3b). Per open sub-issue it classifies readiness with the same criteria as the routing table below:

- A sub-issue that would route to **ready** gets a `route: ready` brief derived non-interactively from its issue body and enters the manifest.
- A sub-issue whose body carries a **recorded-answer block** (a `## Resolved fork` `**Answer:**` block written by `/cw-resolve` when it drained this sub-issue's stalled park) routes **ready**: the fork that stalled it is resolved, so derive the brief from the body **plus the recorded answer** rather than re-classifying the settled fork as fresh and re-parking it. This is what makes a `/cw-resolve` release stick — without it, the restored umbrella would re-park the same fork on the very next scan.
- A sub-issue that would route to **clarify-now** or **back-off-to-brainstorm** — an unresolved design fork a human would have to settle, and with no recorded-answer block resolving it — is **parked** (`cw-status:stalled` + a `needs-input` reason comment) and **excluded from the manifest**. It is never planned; `/cw-resolve` drains that park (records the answer on the sub-issue body, removes `cw-status:stalled`), after which a subsequent scan sees the recorded answer, restores the umbrella, and routes the sub-issue ready.

So the invariant "no brief proceeds carrying an unstated assumption / unresolved fork" holds on **both** paths: number mode closes the gap interactively with the operator present; repo mode parks the gap and excludes the sub-issue rather than guessing. The headless Workflow only ever receives `route: ready` briefs.

## Routing each sub-issue (R2, R3)

For each open sub-issue, in enumeration order:

1. **Read the issue and scan the repo.** Read the issue body and comments. Grep the repo for the surfaces it names (files, commands, endpoints, types). Identify the decisions a plan would need: scope ambiguities, unstated user-facing behavior, design forks, naming, error/edge handling the issue leaves open.

2. **Surface decisions interactively, one question at a time.** Use the platform blocking-question tool (AskUserQuestion). Ask the *plan-blocking* questions only — the ones whose answers change what gets built. Do not ask questions a planner can reasonably decide on its own; those are noise.

3. **Route to one of three states:**

   | State | Signal | Action |
   |-------|--------|--------|
   | **ready** | Issue is clear; a planner has everything it needs. | Write the brief from the issue + any constraints surfaced. |
   | **clarify-now** | A few plan-blocking questions, answerable on the spot. | Resolve them with the operator; capture answers in the brief. |
   | **back-off-to-brainstorm** | Under-specified: a user-facing behavior or scope boundary is genuinely undecided. | Invoke `ce-brainstorm` interactively. Its requirements doc becomes (or is linked by) the brief. The issue then rejoins the ready set. (AE1) |

   Routing to back-off is **not** failure — it is the mechanism catching a gap before it reaches a context-free planner. Prefer back-off over guessing.

4. **Write the readiness brief.** Per `manifest-schema.md`. Capture resolved decisions, answered clarifications, and umbrella-wide constraints. For back-off issues, link the `ce-brainstorm` doc.

## Brief-completeness gate (R3, AE4)

After all issues are routed and briefed, before "go," run a completeness pass over **each** brief:

- Read the brief as if you were the headless planner. Ask: *what would I have to invent to produce a plan from this?*
- Name each such gap explicitly — an unstated default, an undecided boundary, an ambiguous term, a missing constraint.
- Surface the gaps to the operator (one issue at a time) to **fill or explicitly accept**. An explicitly accepted gap is fine; a silent one is not.

The gate's purpose: no brief proceeds to planning carrying unstated assumptions the planner would resolve by guessing. This is the agentic-safety counterpart to having no plan-review human gate — the gap is closed here, with the operator present, not downstream in a context-free subagent.

### What a "gap a planner would invent" looks like

- The issue says "add a `delete` command" but never says whether delete is idempotent, what it prints, or how it handles a missing key. A planner will pick something; the operator should decide.
- The issue names a new endpoint but not its auth/approval posture. In this repo family, write endpoints carry approval gating (ADR-0009) and an idempotency flag (ADR-0010) — a planner inventing these silently is a real risk.
- The issue references "the existing pattern" without saying which file. Name the file in the brief so the planner mirrors the right one.

## Dependency declaration (R6, R8)

After briefs are complete, ask the operator to declare **logical** dependencies — "issue B's implementation needs issue A's merged code," independent of file overlap. These are edges the mechanism cannot infer from issue text.

- Record each as a `depends_on` edge (B depends_on A).
- File-contention ordering is **not** declared here; the Workflow computes it from the plans' predicted ownership tables (set-intersection). Only logical edges are operator-supplied.
- Validate the edges form a DAG. Reject a cycle with a clear error naming the participating issues, and have the operator break it before "go." (The scheduler re-checks in `workflow.js`, but catching it here keeps the operator in the loop.)

## Output of the sweep

- A routed list: every open sub-issue in exactly one of {ready, clarify-now→ready, back-off→ready}.
- One readiness brief per issue (markdown file).
- A set of `depends_on` edges forming a DAG.
- The manifest (`manifest-schema.md`) assembling all of the above.

Nothing downstream is launched until the operator says "go." The sweep produces artifacts only.
