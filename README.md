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

`cw-ship` is the loop you put on a schedule — it is the continuous backlog drainer. (`cw-orchestrate` and `cw-sweep` run on demand, so they do not need a timer.)

### One command

From a clone of this repo:

```sh
bash scripts/install-scheduler.sh
```

or without cloning:

```sh
bash <(curl -fsSL https://raw.githubusercontent.com/ALRubinger/craftwork-skills/main/scripts/install-scheduler.sh)
```

It detects your OS (launchd on macOS, a systemd user timer or cron on Linux), prompts for the repo, a local checkout path, and run times — with defaults, auto-filled from your current checkout when it can — then writes a wrapper and activates the schedule. Handy flags:

- `--dry-run` — print everything it would write and run, and touch nothing.
- `--repo owner/repo --repo-dir ~/code/repo --times 8:13,14:13,20:13 --yes` — run it unattended.
- `--uninstall` — remove the schedule.

Nothing is Claude-specific beyond the `claude -p` call inside the generated wrapper; swap it for another runtime's headless command if needed.

**Before you let it run unattended, do one manual run and watch it:** `claude -p "/cw-ship <owner>/<repo>"` (the loop accepts `build: false` to plan and park without opening PRs).

### Other environments

- **Windows, or manual control over the setup:** the per-OS recipes the installer automates — launchd, cron, a systemd timer, and Windows Task Scheduler — are written out step by step in [`skills/cw-ship/references/scheduling.md`](skills/cw-ship/references/scheduling.md).
- **GitHub Actions cron (no machine required):** a scheduled workflow runs the agent in CI — best for teams. Use [`anthropics/claude-code-action`](https://github.com/anthropics/claude-code-action) (or your agent's equivalent action) on a `schedule:` trigger; the runner needs a token with merge rights and a bot identity allowed to bypass required review.
- **Managed cloud routine:** if your platform offers scheduled agent runs (e.g. Claude Code's `/schedule`), point one at `/cw-ship <owner>/<repo>`. Usually a minimum interval around an hour, and billed.

### Safety, however you schedule it

- These skills perform real merges. **Scope the agent's auth to the target repo** and start with a dry run — `cw-ship` accepts `build: false` to plan and park without opening PRs.
- In a headless run, **do not override the permission mode in a way that re-introduces interactive prompts** — a prompt with no human to answer it hangs the loop. Rely on a pre-approved allowlist instead.
- The everyday loop pages you (`cw-ship` fires a notification when it parks a decision), so an unattended schedule still keeps you in the loop exactly when a human judgment is needed — and only then.

## Status

Early. Versioned at `0.1.0`. The skill contracts are stable enough to use; the packaging for one-command install is still settling. Issues and ideas welcome.
