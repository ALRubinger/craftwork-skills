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
  "repo": "<owner>/<repo>",
  "defaultBranch": "main",
  "runId": "umbrella-989-20260611-1713",
  "timestamp": "2026-06-11T17:13:00Z",
  "issues": [
    {
      "number": 981,
      "title": "Add DELETE /items/{id} endpoint + items rm CLI command",
      "brief_path": "/abs/path/.cw-orchestrate/umbrella-989-20260611-1713/briefs/981.md",
      "depends_on": []
    },
    {
      "number": 984,
      "title": "Add a soft-delete recovery window for deleted items",
      "brief_path": "/abs/path/.../briefs/984.md",
      "depends_on": [981]
    }
  ]
}
```

**The merge target is `defaultBranch`.** `defaultBranch` is the single branch every run uses: the squash-merge lands on it, the pre-merge `git merge-tree` conflict check diffs against it, and every plan/work/autofix subagent fetches and forks off it (so each node builds on the run's accumulated work — each predecessor's PR has already merged onto it).

### Field contract

| Field | Type | Meaning |
|-------|------|---------|
| `umbrella` | number | Parent issue number. |
| `repo` | string | `owner/name`, so subagents can target `gh` explicitly. |
| `defaultBranch` | string | **Merge target AND fork base** (`main` for this repo family): the branch the squash-merge lands on, that the pre-merge `git merge-tree` check diffs against, and that plan/work/autofix subagents fetch and fork off. |
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
title: "Add DELETE /items/{id} endpoint + items rm CLI command"
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
  e.g. write endpoints require [approval] gating and an idempotency
  flag per the repo's ADRs; the API spec is the source of truth.>

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
title: "Bulk item import from a CSV file"
route: back-off
umbrella: 989
brainstorm: docs/brainstorms/2026-06-11-986-bulk-import-requirements.md
---

# Readiness brief: #986

This issue was routed to back-off during the sweep. Its requirements were
established in `ce-brainstorm`:

→ docs/brainstorms/2026-06-11-986-bulk-import-requirements.md

The plan subagent should treat that document as the authoritative requirements
input. Decisions, constraints, and acceptance examples live there.
```

The `brainstorm` frontmatter path is repo-relative; the brief itself lives at the absolute `brief_path` in the working dir. A back-off brief's pointer **must** resolve to the existing `ce-brainstorm` doc — that is invariant (1) for back-off issues.

## Why the brief, not the issue body

A fresh plan subagent has no memory of the sweep. The decisions the operator made, the gaps they accepted, the constraints they named — none of that is in the issue body. The brief is the durable carrier of that judgment across the context boundary. A planner given only the issue would re-derive (and re-invent) everything the sweep already settled.

## Repo-scan mode: headless-derived briefs

In cw-orchestrate's **repo-scan mode** (the `cw-orchestrate` repo-scan mode for `<owner>/<repo>`, the scheduled/opt-in path) there is no interactive sweep — the `cw-umbrella:ready` label already encodes the upstream clearance that the sweep would otherwise supply (human approval for a cw-scope umbrella; cw-ship's autonomous triage judgment for one it filed) (see [readiness-sweep.md](./readiness-sweep.md#two-gate-postures)). The manifest is assembled headlessly, and the contract above is preserved exactly:

- Every brief carries `route: ready`. There are no `clarify-now`/`back-off` briefs in a repo-scan manifest — a sub-issue that *would* need clarification is **parked** (`cw-status:stalled` + a needs-input comment) and **excluded from `issues[]`**, never manifested. So `workflow.js` receives precisely what it does in number mode: only ready briefs.
- A `route: ready` brief is derived **non-interactively from the sub-issue body** (plus a repo scan), substituting for the sweep's operator-supplied decisions. Where number mode captures the operator's resolved decisions, repo mode captures what the issue body already settles — and if the body leaves a genuine fork open, that is exactly the signal to park (not to invent a default), so no ready brief carries a silently-guessed assumption.

All other invariants (absolute `brief_path`, DAG `depends_on`, minted `runId`/`timestamp`) are unchanged.
