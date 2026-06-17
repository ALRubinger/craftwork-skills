# Manifest + Brief Contract

The manifest is the **handoff** between the interactive sweep (main session) and the hands-off Workflow (background). It is the Workflow's sole human-derived input (R6): the Workflow reads it as `args` and derives everything else (plans, ownership tables, schedule) from it. The sweep writes it; the Workflow only reads it.

## Working location

Briefs and the manifest live under a **run-scoped working directory addressed by absolute path**, so the backgrounded Workflow can read them regardless of its working directory:

```
<repo>/.cw-orchestrate/<runId>/
├── manifest.json
└── briefs/
    ├── 981.md
    ├── 984.md
    └── ...
```

- `<repo>/.cw-orchestrate/` keeps run artifacts beside the repo they target (briefs reference repo-relative paths) while staying out of the source tree. Add `.cw-orchestrate/` to the repo's `.gitignore` (or the user's global gitignore) so run artifacts are never committed — they are operator scratch, not deliverables.
- The manifest records **absolute** `brief_path`s. A backgrounded Workflow subagent cannot assume the main session's CWD; absolute paths remove the ambiguity.
- `runId` namespaces concurrent runs and makes re-runs inspectable.

(The plan's Open Question on manifest location is resolved here: a tracked-but-gitignored working dir under the repo, not a `/tmp` path that can be cleared mid-run. Per repo-family convention, recovery/scratch artifacts live under a stable location, never `/tmp`.)

## Manifest schema

```json
{
  "umbrella": 989,
  "repo": "ALRubinger/aileron",
  "defaultBranch": "main",
  "runId": "umbrella-989-20260611-1713",
  "timestamp": "2026-06-11T17:13:00Z",
  "issues": [
    {
      "number": 981,
      "title": "aileron vault put/delete/list CLI + daemon DELETE endpoint",
      "brief_path": "/abs/path/.cw-orchestrate/umbrella-989-20260611-1713/briefs/981.md",
      "depends_on": []
    },
    {
      "number": 984,
      "title": "Capture freshness comparison + vault-delete resurrection mitigation",
      "brief_path": "/abs/path/.../briefs/984.md",
      "depends_on": [981]
    }
  ]
}
```

### Field contract

| Field | Type | Meaning |
|-------|------|---------|
| `umbrella` | number | Parent issue number. |
| `repo` | string | `owner/name`, so subagents can target `gh` explicitly. |
| `defaultBranch` | string | Merge target (`main` for this repo family). |
| `runId` | string | Stable run identifier. **Minted in the main session** — the Workflow forbids `Date.now()`/`Math.random()`. |
| `timestamp` | string (ISO 8601) | Run start. Also minted in the main session; passed through for any time-stamping the Workflow needs. |
| `issues[]` | array | One entry per **ready** sub-issue (back-off issues are ready once their `ce-brainstorm` doc exists). |
| `issues[].number` | number | Sub-issue number. |
| `issues[].title` | string | For display/logging. |
| `issues[].brief_path` | string (absolute) | Path to the readiness brief markdown file. Must resolve to an existing file. |
| `issues[].depends_on` | number[] | Declared **logical** dependency edges (this issue depends on each listed issue). File-overlap edges are computed later, not stored here. |

### Invariants (validate before "go")

1. Every `brief_path` resolves to an existing readable file.
2. Every `depends_on` entry references a `number` present in `issues[]`.
3. The `depends_on` edges form a **DAG** — no cycles. Reject a cycle with an error naming the participating issues. (The scheduler in `workflow.js` re-validates; catching it here keeps the operator in the loop.)
4. `runId` and `timestamp` are present and non-empty (the Workflow depends on them for determinism).

## Brief contract

One markdown file per sub-issue, written by the sweep, read by the plan subagent as its sole human-derived input (R5).

### Ready / clarify-now brief shape

```markdown
---
issue: 981
title: "aileron vault put/delete/list CLI + daemon DELETE endpoint"
route: ready            # ready | clarify-now | back-off
umbrella: 989
---

# Readiness brief: #981

## What this issue is
<1–3 sentences: the work, in the operator's framing.>

## Resolved decisions
- <decision the operator made during the sweep, with the chosen option>
- <...>

## Constraints
- <umbrella-wide or repo-family constraint the planner must honor —
  e.g. write endpoints carry [approval] gating per ADR-0009 and an
  idempotency flag per ADR-0010; OpenAPI spec is source of truth.>

## Accepted gaps
- <gap the operator explicitly chose to leave to the planner, if any>

## Pointers
- <repo-relative files/patterns the plan should mirror>
- <related ADRs, prior PRs>
```

### Back-off brief shape

A back-off issue's brief links its `ce-brainstorm` requirements doc instead of re-deriving decisions:

```markdown
---
issue: 986
title: "aileron auth <agent> --import-from-host"
route: back-off
umbrella: 989
brainstorm: docs/brainstorms/2026-06-11-986-import-from-host-requirements.md
---

# Readiness brief: #986

This issue was routed to back-off during the sweep. Its requirements were
established in `ce-brainstorm`:

→ docs/brainstorms/2026-06-11-986-import-from-host-requirements.md

The plan subagent should treat that document as the authoritative requirements
input. Decisions, constraints, and acceptance examples live there.
```

The `brainstorm` frontmatter path is repo-relative; the brief itself lives at the absolute `brief_path` in the working dir. A back-off brief's pointer **must** resolve to the existing `ce-brainstorm` doc — that is invariant (1) for back-off issues.

## Why the brief, not the issue body

A fresh plan subagent has no memory of the sweep. The decisions the operator made, the gaps they accepted, the constraints they named — none of that is in the issue body. The brief is the durable carrier of that judgment across the context boundary. A planner given only the issue would re-derive (and re-invent) everything the sweep already settled.
