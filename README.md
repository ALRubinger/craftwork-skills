# CraftWork

**You supply the taste. The machine supplies the labor.**

CraftWork is an opinionated suite of agent skills that turns lived-experience feedback into merged pull requests, using **GitHub issues as a durable, asynchronous state machine** and engaging you only at genuine decision points. You observe, you decide, it ships — and the agent does the work in between.

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
cw-promote      land a proven integration branch -> one squash commit on main
cw-sweep        clean up leftover review notes  -> a tidy backlog
```

Two tracks share the same philosophy:

- **Everyday track** - you hit a rough edge while using the product, run `cw-feedback`, and when you're ready you invoke `/cw-ship` to turn the backlog into merged changes. If an item needs a decision, it parks the question into the issue body and pings you; you answer with `cw-resolve` and the next run finishes it on its own.
- **Initiative track** - for deliberate, multi-PR work you run `cw-scope` to shape it, then `cw-orchestrate` to drive it to done, with `cw-sweep` clearing the review residue. An integration-targeted initiative (one whose sub-issues build onto a shared `integration/<slug>` branch) finishes with `cw-promote`, which atomically lands that branch on `main` once the whole feature is proven.

The split maps to the names: **Craft** is what you fire to capture and decide (`cw-feedback`, `cw-resolve`, `cw-scope`); **Work** is what runs hands-off to merge once you invoke it (`cw-ship`, `cw-orchestrate`, `cw-sweep`, `cw-promote`).

## The skills

| Skill | Track | What it does |
|-------|-------|--------------|
| [`cw-feedback`](skills/cw-feedback) | everyday | Capture a plain-English observation as one GitHub issue. |
| [`cw-ship`](skills/cw-ship) | everyday | On-demand loop you invoke (`/cw-ship`): plan each captured item against the code, build + merge the clear ones, park the rest, escalate the big ones. |
| [`cw-resolve`](skills/cw-resolve) | everyday | Walk you through the design questions the loop parked, record your answers, release the work. |
| [`cw-scope`](skills/cw-scope) | initiative | Interactively scope a large initiative into a ready set of sub-issues. |
| [`cw-orchestrate`](skills/cw-orchestrate) | initiative | Drive a scoped initiative's sub-issues to merged PRs, hands-off. |
| [`cw-promote`](skills/cw-promote) | initiative | Atomically squash-promote a proven `integration/<slug>` branch into `main`, then close the umbrella and tear down the target. |
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

If you're *developing* the suite from a clone and want `/cw-*` to run your working tree (live edits, no publish step), symlink the skills into your Claude skills dir instead:

```sh
task link              # symlink every skills/* into ~/.claude/skills
task link -- --dry-run # preview; --force replaces conflicting links
```

It's idempotent — re-run it after adding a skill so nothing goes stale. Use this on your authoring machine; use the marketplace on machines that only consume the suite (don't do both, or each skill loads twice).

The Work-track skills (`cw-ship`, `cw-orchestrate`, `cw-sweep`, `cw-promote`) drive real merges via `gh`/`git` once you invoke them — `cw-ship` and `cw-orchestrate` are on-demand, and `cw-sweep` can optionally be put on a schedule. `cw-ship`, `cw-orchestrate`, and `cw-sweep` run hands-off to merge; `cw-promote` is the one operator-gated exception in the Work track — it lands a proven integration branch on `main` only after an explicit operator confirmation. Read each skill's `SKILL.md` before running it, and start with a dry run.

## Running the loops

`cw-ship` is on-demand — you invoke `/cw-ship <owner>/<repo>` when you want the feedback backlog drained, and `cw-orchestrate` likewise runs when you hand it an umbrella. Neither is wired to a timer.

`cw-sweep` is the one loop you may *optionally* put on a schedule, to drain the `cw-review-residual` backlog out of band; `cw-orchestrate` already triages its own residuals in-band, so it does not need one either.

### Optional: schedule cw-sweep

Scheduling is strictly opt-in. If you deliberately want `cw-sweep` running on a timer, the installer sets it up. From a clone of this repo:

```sh
bash scripts/install-scheduler.sh --skill cw-sweep
```

or without cloning:

```sh
bash <(curl -fsSL https://raw.githubusercontent.com/ALRubinger/craftwork-skills/main/scripts/install-scheduler.sh) --skill cw-sweep
```

It detects your OS (launchd on macOS, a systemd user timer or cron on Linux), prompts for the repo, a local checkout path, and run times — with defaults, auto-filled from your current checkout when it can — then writes a wrapper and activates the schedule. `--skill cw-sweep` is required; `cw-ship` is intentionally not schedulable here. Handy flags:

- `--skill cw-sweep` — the only schedulable loop. It defaults to a light `12:30,21:30` cadence and bakes a non-interactive prompt into its wrapper so the headless run does not block on its scope/autofix questions.
- `--dry-run` — print everything it would write and run, and touch nothing.
- `--repo owner/repo --repo-dir ~/code/repo --times 12:30,21:30 --yes` — run it unattended.
- `--uninstall` — remove the schedule (pair with `--skill cw-sweep`).

Nothing is Claude-specific beyond the `claude -p` call inside the generated wrapper; swap it for another runtime's headless command if needed.

**Before you let it run unattended, do one manual run and watch it:** run `/cw-sweep <owner>/<repo>` interactively first with autofix off, to eyeball the escalation surface before letting the scheduled run apply fixes.

### Other environments

- **Windows, manual control, or scheduling cw-ship anyway:** the per-OS recipes — launchd, cron, a systemd timer, and Windows Task Scheduler — are written out step by step in [`skills/cw-ship/references/scheduling.md`](skills/cw-ship/references/scheduling.md), where scheduling is documented as a deliberate opt-in rather than the default.
- **GitHub Actions cron (no machine required):** for a scheduled `cw-sweep`, a workflow can run the agent in CI — best for teams. Use [`anthropics/claude-code-action`](https://github.com/anthropics/claude-code-action) (or your agent's equivalent action) on a `schedule:` trigger; the runner needs a token with merge rights and a bot identity allowed to bypass required review. (`cw-ship` is on-demand — invoke it from an Action manually, e.g. `workflow_dispatch`, rather than on a timer.)
- **Managed cloud routine:** if your platform offers scheduled agent runs (e.g. Claude Code's `/schedule`), you can point one at `/cw-sweep <owner>/<repo>`. Usually a minimum interval around an hour, and billed. Invoke `/cw-ship` on demand instead of scheduling it.

### Safety, however you run them

- These skills perform real merges. **Scope the agent's auth to the target repo** and start with a dry run — `cw-ship` accepts `build: false` to plan and park without opening PRs.
- In a headless run, **do not override the permission mode in a way that re-introduces interactive prompts** — a prompt with no human to answer it hangs the loop. Rely on a pre-approved allowlist instead.
- The everyday loop pages you (`cw-ship` fires a notification when it parks a decision), so even a long unattended `/cw-ship` run keeps you in the loop exactly when a human judgment is needed — and only then.

## Status

Early. Versioned at `0.1.0`. The skill contracts are stable enough to use; the packaging for one-command install is still settling. Issues and ideas welcome.
