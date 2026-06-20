# Feedback issue template

The capture skill files exactly one issue per observation, with both `cw-feedback` and `cw-feedback:new` labels. The body is intentionally small — it records *intent*, and the triage loop researches the *how*.

## Title

`<kind>: <imperative summary of the desired change>`

- `kind` ∈ `bug` | `annoyance` | `enhancement` | `idea` (Step 3).
- The summary is what you want *to be true*, in imperative voice, ≤ ~70 chars. Not "the banner is annoying" but "stop repeating the launch banner on every shell command".

## Body

```markdown
## Observation

<one or two sentences: what you saw in real use>

## What I don't like

<what's wrong with it, in your framing — the gripe>

## What I want changed

<the outcome you want. Intent, not a prescription. A fix hint is fine if you
have one, but say it's a hint.>

## Context

- **Repo:** <owner/name>
- **Surface:** <product surface, e.g. a CLI command, web app, an API endpoint, docs> (or "unknown")
- **Where seen:** <command / page / flow, verbatim if the user named it> (or "n/a")
- **Kind:** <bug | annoyance | enhancement | idea>

<!-- cw-ship appends an "## Open questions" block below this line when it
     needs your input. Run /cw-resolve to answer (or answer inline and add the
     `cw-feedback:go` label yourself) to resume autonomous execution. -->
```

## Rules

- Always `--body-file` (or a quoted heredoc). Never hand-escape backticks or `- [ ]`.
- Leave the trailing HTML comment in place — it's the contract that tells the operator where parked questions appear and how to clear them.
- Don't add a fix checklist, acceptance criteria, or sub-tasks. That structure is the triage planner's output, not capture's. Capture stays a thin record of intent.
- One observation per issue. If the user described several distinct things, file several issues.
