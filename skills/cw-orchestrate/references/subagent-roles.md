# Subagent Roles

The Workflow fans out three subagent roles: **plan**, **review**, and **work**. Each runs in a fresh context (the isolation the mechanism is built for). Roles are **inlined prompts with structured output**, not literal `/ce-plan`, `/ce-doc-review`, or `/ce-work` slash-command invocations — subagents can't drive interactive skills, and the CE skills live in a read-only plugin (KTD4).

This file is the **canonical, human-readable** statement of each role's prompt and output schema. `workflow.js` inlines string constants that mirror these (a Workflow script has no filesystem access at runtime, so it cannot read this file — keep the two in sync; this file is the source of truth for the prose, `workflow.js` is what actually runs).

A note on schemas: `agent(prompt, { schema })` forces the subagent to call a `StructuredOutput` tool and returns the validated object — validation happens at the tool-call layer, so a malformed response is retried by the harness until it conforms. Roles below rely on that; assert the contract, not the retry internals.

---

## Plan role (U4 — R7, R8)

**Purpose:** Produce a plan for one sub-issue and a machine-parseable file-ownership table the scheduler can intersect.

**Inputs (interpolated into the prompt):** the sub-issue number/title, the full readiness brief text (and, for back-off issues, the linked `ce-brainstorm` doc), the repo and default branch.

**Prompt shape:**

> You are planning a single GitHub sub-issue in a fresh context. You will NOT implement it; you produce a plan document and a file-ownership table.
>
> Issue: #{number} — {title} (repo {repo}, default branch {defaultBranch}).
>
> Readiness brief (the operator's resolved decisions and constraints — authoritative; do not re-litigate):
> ```
> {brief_text}
> ```
>
> Apply planning discipline equivalent to a senior engineer's implementation plan: state key decisions, break the work into ordered implementation units (goal, files, approach, test scenarios, verification per unit), and call out scope boundaries. Honor every constraint in the brief. Where the brief names a pattern or file to mirror, follow it. Respect repo conventions (e.g. OpenAPI spec is source of truth; write endpoints carry approval gating and an idempotency flag).
>
> Then enumerate the **complete set of repo-relative paths** your implementation will create or modify — source, generated, and test files. Be exhaustive and conservative: a path you will touch but omit becomes an undetected merge collision later. List a path even if you are only moderately sure you will touch it. Do not list paths you are confident you will not touch (over-listing serializes unrelated work unnecessarily).
>
> Return structured output conforming to the schema.

**Output schema (`OWNERSHIP_SCHEMA`):**

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["issue", "plan_markdown", "ownership_paths"],
  "properties": {
    "issue":         { "type": "integer" },
    "plan_markdown": { "type": "string", "minLength": 1 },
    "ownership_paths": {
      "type": "array",
      "items": { "type": "string", "minLength": 1 },
      "minItems": 1
    }
  }
}
```

- `ownership_paths` are repo-relative (`internal/api/openapi.yaml`, not absolute). The scheduler intersects these across issues; absolute or inconsistent paths would defeat the set-intersection.
- The Workflow writes `plan_markdown` to `docs/plans/` (or the run working dir) as the durable handoff to the work role.
- Plan subagents run **fully in parallel** — planning produces documents only and carries no code-level ordering (R8).

---

## Review role (Stage 1.5, U5 — R9, R10, R11)

**Purpose:** Doc-review one plan. Decide P0 (halt) vs. non-P0 (file-and-proceed), and emit the residual findings to file.

**Inputs:** the plan markdown, the issue number, the umbrella number, the brief (for intent comparison).

**Prompt shape:**

> You are doc-reviewing an implementation plan in a fresh context. Judge whether the plan is fit to execute hands-off, with no human gate between here and merge.
>
> Issue #{number} (umbrella #{umbrella}). Plan:
> ```
> {plan_markdown}
> ```
> Operator's brief (intent — the plan must serve this):
> ```
> {brief_text}
> ```
>
> Classify findings by severity. A **P0** is a finding that, if it ships, produces wrong, unsafe, or scope-violating work that the operator would not have approved — a misread requirement, a missing safety/approval gate, a data-loss path, a plan that contradicts the brief. Non-P0 findings are real but survivable improvements.
>
> Decide: is there at least one P0? If yes, this sub-issue must be **halted** (withheld from scheduling) until a human triages it. Either way, list the residual findings (everything not trivially auto-fixable) so they can be filed as one tracked issue.
>
> Return structured output conforming to the schema.

**Output schema (`REVIEW_SCHEMA`):**

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["issue", "p0", "residuals"],
  "properties": {
    "issue": { "type": "integer" },
    "p0":    { "type": "boolean" },
    "residuals": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["severity", "title", "detail"],
        "properties": {
          "severity": { "type": "string", "enum": ["P0", "P1", "P2"] },
          "title":    { "type": "string", "minLength": 1 },
          "detail":   { "type": "string", "minLength": 1 }
        }
      }
    }
  }
}
```

**Workflow handling of the verdict:**

- `p0 === true` → mark the sub-issue **halted**: exclude it from scheduling, cascade-halt its dependents, and file the residual issue. (AE3)
- `p0 === false` with non-empty `residuals` → file the residual issue and **proceed** to scheduling.
- `p0 === false` with empty `residuals` → proceed, file nothing.

**Residual filing** (R11) — one consolidated issue per sub-issue:

```bash
gh issue create \
  --repo "$repo" \
  --title "cw-review-residual: plan findings for #$issue" \
  --label "cw-review-residual" \
  --body-file <(printf '%s\n' "$body")   # structured body; see below
```

- Create the `cw-review-residual` label on first use if absent (`gh label create cw-review-residual --color BFD4F2 --description "Deferred cw-orchestrate plan/diff review findings"`).
- Body links **both** the sub-issue (`Relates to #$issue`) and the umbrella (`Umbrella #$umbrella`), and lists findings severity-first so P0 surfaces at the top of triage.
- Structure the body so a **future** `cw-orchestrate` run can adopt the residual as a sub-issue: a clear title, a "What" section, and an "Acceptance" section (R11, R20).

---

## Work role (Stage 2, U7 — R13–R16)

**Purpose:** Take one scheduled node from plan to a merged PR, in an isolated worktree, under the full merge-safety contract.

**Dispatch:** `agent(workPrompt(node), { isolation: 'worktree', schema: BUILD_SCHEMA, phase: 'Work' })`. The `isolation: 'worktree'` gives the subagent its own working tree so nodes building in parallel don't corrupt each other's index.

**The work role does NOT merge.** It implements, opens the PR, and runs a code-review pass, then returns. The Workflow performs the actual merge **serially** in a separate step (see `merge-safety.md`) so only one node merges to the default branch at a time.

**Prompt shape:**

> You are implementing one GitHub issue in an isolated git worktree, in a fresh context, with no human available. Take it from plan to an open, review-clean PR — but do NOT merge; the orchestrator merges serially after you return.
>
> Issue #{number} (repo {repo}, base {defaultBranch}). Plan:
> ```
> {plan_markdown}
> ```
>
> Steps:
> 1. Create a branch off fresh `{defaultBranch}` in your worktree.
> 2. Implement the plan. Follow repo conventions (AGENTS.md/CLAUDE.md): regenerate generated files rather than hand-editing; write tests for new behavior; keep coverage above the repo bar.
> 3. Run the repo's build + test suite. Tests must pass before you open a PR.
> 4. Open a PR with a conventional-commit title and a Summary + Test plan body. The body **must include a `Closes #{number}` line** (on its own line) so the squash-merge auto-closes the sub-issue — the orchestrator's Step 7 reconciliation is a backstop, not a substitute. Push the branch.
> 5. Run a code-review pass over your own diff. Classify a **P0** as a correctness/security/data-loss/scope finding that must not merge. If you find a P0, fix it and re-review; if it cannot be safely auto-fixed in this context, leave the PR open and report `p0: true` with the finding — do NOT merge-signal.
> 6. Report the PR number/URL, the branch name, the files you actually changed, and your P0 verdict.
>
> If you cannot reach a green build + passing tests + clean review, report `ready_to_merge: false` with the cause rather than papering over it.

The work role branches off and tests against fresh `{defaultBranch}` — the branch the serial merge step squash-merges onto, which also serves as the fork base so each node builds on the run's accumulated work (each predecessor's PR has already merged onto it).

**Output schema (`BUILD_SCHEMA`):**

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["issue", "ready_to_merge", "p0"],
  "properties": {
    "issue":          { "type": "integer" },
    "ready_to_merge": { "type": "boolean" },
    "p0":             { "type": "boolean" },
    "pr_number":      { "type": ["integer", "null"] },
    "pr_url":         { "type": ["string", "null"] },
    "branch":         { "type": ["string", "null"] },
    "changed_paths":  { "type": "array", "items": { "type": "string" } },
    "cause":          { "type": ["string", "null"] }
  }
}
```

- `ready_to_merge: true, p0: false` → eligible for the serial merge step.
- `p0: true` → PR left open; node marked **stalled** (cause = the P0 finding); dependents halted. (R15)
- `ready_to_merge: false` → node **stalled** with `cause`; dependents halted. (R17)
- `changed_paths` records what the node *actually* touched — useful for post-hoc collision diagnosis even though scheduling used predicted ownership.

The merge step (`MERGE_SCHEMA`, the pre-merge `git merge-tree` check, serialization, and the conflict/P0 halts) is specified in `merge-safety.md`.
