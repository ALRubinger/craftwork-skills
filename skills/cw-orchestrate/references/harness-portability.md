# Agent harness portability

CraftWork skills are Agent Skills first. They are specified in terms of
capabilities, not a preferred agent harness. When a harness has a richer native
primitive for one capability, use it. When it does not, use the portable
fallback without weakening the GitHub state machine, safety gates, or reports.

## Capability names

Use these generic capability names in skill instructions:

| Generic capability | Example harness mapping | Portable fallback |
| --- | --- | --- |
| Blocking question | `AskUserQuestion` | Ask the user directly, one concise question at a time. If the harness has a structured question UI, use it; otherwise use normal chat. |
| Background workflow | A Workflow API with `scriptPath` | Run the same phases in the main session, optionally using the harness's own subagent/delegation tools. |
| Worker/subagent | `agent(...)` inside `workflow.js` | Do the role locally, or delegate through the harness's native subagent mechanism when available and safe. |
| Worktree isolation | `isolation: 'worktree'` | Create an explicit `git worktree` per implementation/autofix task and keep scratch outside the primary checkout. |
| Push notification | `PushNotification` | Report the parked decisions in the final message and make the issue labels/body the durable notification. |
| Tool discovery | A tool-search/discovery API | Use the harness's tool-discovery mechanism if it has one; otherwise rely on ordinary chat and shell tools. |

Never mention a harness-specific tool as a requirement without also naming the
portable fallback.

## Execution modes

Every Work-track skill supports two execution modes:

1. **Harness workflow mode.** If the current harness can run the bundled
   `workflow.js` via a compatible Workflow API, use it. This preserves the
   workflow-script behavior: background execution where supported, parallel
   role agents, structured schemas, worktree isolation, serialized merges, and
   run-scoped cleanup keyed by the returned workflow run id.
2. **Portable foreground mode.** If no compatible Workflow API exists, do not
   fail. Execute the same documented phases in the main session. Preserve the
   same state-machine, labels, GitHub issue-body contracts, safety gates, merge
   rules, and reports. Parallelism is optional; correctness is not.

### Codex / native subagent mode

Some harnesses (notably Codex) expose native subagents but no compatible
Workflow API. In that case, portable foreground mode should still fan out work
through native subagents whenever the active tool policy allows it:

- Treat an explicit invocation of a Work-track skill (`cw-ship`,
  `cw-orchestrate`, or `cw-sweep`) as authorization to use the skill's documented
  worker/subagent fanout, because delegation is part of the requested behavior.
  Do not stop to ask a second permission question solely because the harness
  requires explicit user permission for subagents.
- If the harness tool itself still refuses subagent creation, continue locally
  and report that the harness rejected delegation. Do not weaken GitHub safety
  gates or merge rules.
- Preserve the same division of roles as Workflow mode: planning/review/park
  tasks may share the primary checkout but must write scratch only under
  `mktemp -d`; implementation/autofix/build tasks must use explicit
  run-scoped `git worktree` checkouts; merging remains serialized in the main
  session.
- The foreground controller owns orchestration: discover work, spawn eligible
  native subagents, collect their structured results, dispatch follow-on work as
  each result lands, perform serialized merges/reconciliation, and clean up
  run-scoped worktrees. Native subagents replace Workflow `agent(...)` calls;
  they do not replace the skill's state machine.

Portable foreground mode may be slower and may keep the operator's session open
for the whole run, but it must not weaken the behavior. In particular:

- Use `gh`/`git` for GitHub and repository operations.
- Preserve all dry-run/build/autofix switches.
- Create explicit temporary directories with `mktemp -d` for scratch.
- For implementation or autofix work, create a dedicated `git worktree`, branch
  from `origin/<defaultBranch>`, and remove it only after the same merge-state
  checks the skill already documents.
- Apply the same structured-output shape from `workflow.js`/`SKILL.md` in the
  final report even if the harness cannot enforce JSON schemas.
- Keep GitHub as the source of truth: issue labels and body blocks must be
  updated before reporting success.
- Never merge over unresolved conflicts, pending/failing blocking CI, or a P0
  plan/review finding.

## How to use `workflow.js` without a compatible Workflow API

The bundled `workflow.js` files are executable only in a compatible Workflow
runtime because they rely on globals such as `args`, `agent`, `parallel`,
`pipeline`, `phase`, `log`, and worktree `isolation`. In a harness without that
API, treat `workflow.js` as the canonical phase map, schemas, and prompt source,
not as a Node script to run directly.

If implementing a native adapter for another harness, map those globals to the
harness API and keep the adapter outside the skill contract. Do not fork the
skill behavior: the labels, issue-body blocks, routing decisions, and merge
safety rules remain the contract.

## Interaction rules

- Ask at most one blocking question at a time.
- Lead with the recommended option when the skill has one.
- Always provide a skip/wait path for parked decisions.
- In headless/non-interactive runs, never invent an answer; park the question in
  the issue body and label it for the matching resolve loop.
