# CraftWork

**You supply the taste. The machine supplies the labor.**

CraftWork is an opinionated suite of agent skills that turns lived-experience feedback into merged pull requests, using **GitHub issues as a durable, asynchronous state machine** and engaging you only at genuine decision points. You observe, you decide, it ships. Everything in between runs unattended.

It is built for [Claude Code](https://claude.com/claude-code) and any agent runtime that supports the [Agent Skills](https://agentskills.io) standard.

## Why it exists

Two systems already cover parts of this space. [Compound Engineering](https://github.com/EveryInc/compound-engineering-plugin) (`ce-`) is a synchronous, in-session craftsman's pipeline you drive by hand. [GitHub Agentic Workflows](https://github.blog/changelog/2026-06-11-github-agentic-workflows-is-now-in-public-preview/) runs discrete, cloud-side automations like issue triage.

CraftWork is the part neither covers: a single loop that starts from **a plain-English reaction while you use your own product**, holds an **asynchronous design-decision gate** (the agent parks the questions it cannot answer into the issue body and waits for you), and then runs **autonomously all the way to merge** once you have cleared it. The human is the conductor. The machine is the orchestra.

## The loop

```
cw-feedback     capture an observation         -> a GitHub issue
cw-ship         the autonomous loop            -> build + merge, or park, or escalate
cw-resolve      answer the parked questions    -> clears work to run autonomously
cw-scope        scope a large initiative       -> a ready umbrella of sub-issues
cw-orchestrate  execute a scoped initiative    -> sub-issues driven to merged PRs
cw-sweep        clean up leftover review notes  -> a tidy backlog
```

Two tracks share the same philosophy:

- **Everyday track** - you hit a rough edge while using the product, run `cw-feedback`, and the scheduled `cw-ship` loop turns it into a merged change. If it needs a decision, it parks the question into the issue body and pings you; you answer with `cw-resolve` and it finishes on its own.
- **Initiative track** - for deliberate, multi-PR work you run `cw-scope` to shape it, then `cw-orchestrate` to drive it to done, with `cw-sweep` clearing the review residue.

The split maps to the names: **Craft** is what you fire (`cw-feedback`, `cw-resolve`, `cw-scope`); **Work** is what runs on its own (`cw-ship`, `cw-orchestrate`, `cw-sweep`).

## The skills

| Skill | Track | What it does |
|-------|-------|--------------|
| [`cw-feedback`](skills/cw-feedback) | everyday | Capture a plain-English observation as one GitHub issue. |
| [`cw-ship`](skills/cw-ship) | everyday | Scheduled loop: plan each captured item against the code, build + merge the clear ones, park the rest, escalate the big ones. |
| [`cw-resolve`](skills/cw-resolve) | everyday | Walk you through the design questions the loop parked, record your answers, release the work. |
| [`cw-scope`](skills/cw-scope) | initiative | Interactively scope a large initiative into a ready set of sub-issues. |
| [`cw-orchestrate`](skills/cw-orchestrate) | initiative | Drive a scoped initiative's sub-issues to merged PRs, hands-off. |
| [`cw-sweep`](skills/cw-sweep) | initiative | Clean up the leftover review findings after an orchestrate run. |

## Install

With the [`skills`](https://github.com/vercel-labs/skills) CLI:

```sh
# list what's in the suite
npx skills add ALRubinger/craftwork-skills --list

# install the whole suite
npx skills add ALRubinger/craftwork-skills

# or pick individual skills
npx skills add ALRubinger/craftwork-skills --skill cw-feedback --skill cw-ship
```

Or as a Claude Code plugin marketplace:

```sh
/plugin marketplace add ALRubinger/craftwork-skills
```

The autonomous skills (`cw-ship`, `cw-orchestrate`, `cw-sweep`) drive real merges via `gh`/`git` and are designed to run unattended on a schedule. Read each skill's `SKILL.md` before wiring it to a cron, and start with a dry run.

## Scheduling the autonomous loops

A loop is just a slash command. To run one unattended, have any agent runtime execute it **non-interactively, on a timer**. Nothing here is Claude-specific beyond the example invocation; any runtime that can run a skill headlessly plus any scheduler gives you the loop.

**1. Local cron / launchd / systemd → headless agent.** Point your OS scheduler at a one-line wrapper that runs the skill headlessly. With Claude Code that is:

```sh
claude -p "/cw-ship <owner>/<repo>"
```

Fire it from cron (`13 9 * * *`), a macOS LaunchAgent, or a systemd timer. The skill holds its own run lock and is idempotent, so overlapping or retried runs are safe. A complete worked example — wrapper, plist, retry loop, permission notes — is in [`skills/cw-ship/references/scheduling.md`](skills/cw-ship/references/scheduling.md) (written for the author's macOS setup; adapt the paths and repo). For another agent, substitute its non-interactive invocation for `claude -p`.

**2. GitHub Actions cron (repo-native, no laptop required).** A scheduled workflow that runs the agent in CI — best for teams, or when you do not want the loop tied to one machine. Use [`anthropics/claude-code-action`](https://github.com/anthropics/claude-code-action) (or your agent's equivalent action) on a `schedule:` trigger. The runner needs a token with merge rights, and the bot identity must be allowed to bypass required review.

**3. Managed cloud routine.** If your platform offers scheduled agent runs (e.g. Claude Code's `/schedule`), point one at the loop command. These usually enforce a minimum interval (around an hour) and are billed.

**Safety, however you schedule it:**

- These skills perform real merges. **Scope the agent's auth to the target repo** and start with a dry run (`cw-ship` accepts `build: false` to plan and park without opening PRs).
- In a headless run, **do not override the permission mode in a way that re-introduces interactive prompts** — a prompt with no human to answer it hangs the loop. Rely on a pre-approved allowlist instead.
- The everyday loop pages you (`cw-ship` fires a notification when it parks a decision), so an unattended schedule still keeps you in the loop exactly when a human judgment is needed — and only then.

## Status

Early. Versioned at `0.1.0`. The skill contracts are stable enough to use; the packaging for one-command install is still settling. Issues and ideas welcome.
