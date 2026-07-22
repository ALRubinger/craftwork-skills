# CraftWork

**You supply the taste. The machine supplies the labor.**

**Batch your craft; defer the work.** Apply judgment in bursts — capture feedback, make the up-front decisions, review — as durable items, and an agent drains them to merged pull requests in between. You work when you're inspired; the machine labors when you're not. The value is time-shifting: your taste, applied in concentrated bursts, and the labor of turning it into shipped code moved off your critical path.

The mechanism is a **durable state machine plus a context engine**. Your craft decisions live as addressable state; CraftWork drives each one to done, engaging you only at genuine decision points. It uses **GitHub issues as that state machine** — your decisions live where your work already lives, with no bespoke database. That's not an arbitrary storage pick: because a GitHub issue is durable, addressable, and notifies you, it's exactly what an *asynchronous decision gate* needs. A question the agent can't answer parks in the issue body and pings you; the run picks up precisely where it left off once you answer.

## Requirements

- **Claude Code.** CraftWork is a Claude Code skill suite. It runs there, and nowhere else.
- **GitHub.** Issues are the durable, addressable, notifying substrate the async decision gate depends on — your repo and its issues live on GitHub.

## Craft and Work — the two tracks

The name says it: **Craft** is what *you* fire to capture and decide; **Work** is what runs hands-off to merge once you invoke it. The split maps to two tracks that share one philosophy — you hold the taste, the machine holds the labor.

- **Everyday track** — you hit a rough edge while using the product, run `cw-feedback`, and when you're ready you invoke `/cw-ship` to turn the backlog into merged changes. If an item needs a decision, it parks the question into the issue body and pings you; you answer with `cw-resolve` and the next run finishes it on its own.
- **Initiative track** — for deliberate, multi-PR work you run `cw-scope` to shape it, then `cw-orchestrate` to drive it to done — each sub-issue squash-merging straight to `main` — with `cw-sweep` clearing the review residue.

**Craft:** `cw-feedback`, `cw-resolve`, `cw-scope`. **Work:** `cw-ship`, `cw-orchestrate`, `cw-sweep`.

## Why it exists

Two systems already cover parts of this space. [Compound Engineering](https://github.com/EveryInc/compound-engineering-plugin) (`ce-`) is a synchronous, in-session craftsman's pipeline you drive by hand. [GitHub Agentic Workflows](https://github.blog/changelog/2026-06-11-github-agentic-workflows-is-now-in-public-preview/) runs discrete, cloud-side automations like issue triage.

CraftWork is the part neither covers: it starts from **a plain-English reaction while you use your own product**, holds an **asynchronous design-decision gate** (the agent parks the questions it cannot answer into the issue body and waits for you), and then runs **hands-off all the way to merge** once you have cleared it. The human is the conductor; the machine is the orchestra.

## The skills

| Skill | Track | What it does |
|-------|-------|--------------|
| [`cw-feedback`](skills/cw-feedback) | everyday | Capture a plain-English observation as one GitHub issue. |
| [`cw-ship`](skills/cw-ship) | everyday | On-demand loop you invoke (`/cw-ship`): plan each captured item against the code, build + merge the clear ones, park the rest, escalate the big ones. |
| [`cw-resolve`](skills/cw-resolve) | everyday | Walk you through the design questions `cw-ship` parked, record your answers, release the work. |
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

If you're *developing* the suite from a clone and want `/cw-*` to run your working tree (live edits, no publish step), symlink the skills into your Claude skills dir instead:

```sh
task link              # symlink every skills/* into ~/.claude/skills
task link -- --dry-run # preview; --force replaces conflicting links
```

It's idempotent — re-run it after adding a skill so nothing goes stale. Use this on your authoring machine; use the marketplace on machines that only consume the suite (don't do both, or each skill loads twice).

## Your first loop

The everyday track, end to end. All you need is an installed suite and an authenticated `gh` (`gh auth status`).

1. **Capture** a reaction while you're using your product. In Claude Code:

   ```
   /cw-feedback
   ```

   Say what you noticed in plain English ("the error message on a bad token is useless"). It files **one** GitHub issue labeled `cw-feedback:new`. Do this whenever something grates — it's cheap.

2. **Drain** the backlog when you're ready:

   ```
   /cw-ship <owner>/<repo>
   ```

   It plans each captured item against your actual code, builds and squash-merges the clear ones, and parks anything that needs a decision back into the issue body — pinging you when it does.

3. **Decide** on anything it parked:

   ```
   /cw-resolve
   ```

   It walks you through the open questions one at a time with a recommended answer pre-filled, writes your answers back into the issue, and releases the work. Re-run `/cw-ship <owner>/<repo>` and it finishes those items on its own.

That's the whole everyday loop: observe → decide → it ships. The initiative track is the same shape at a larger grain — `cw-scope` to shape a multi-PR effort, `cw-orchestrate` to drive it, `cw-sweep` to tidy up.

## Safety

The Work-track skills (`cw-ship`, `cw-orchestrate`, `cw-sweep`) drive real merges via `gh`/`git` once you invoke them. All three are on-demand — you invoke them — and run hands-off to merge from there. Before you turn one loose:

- **Scope the agent's auth to the target repo**, and start with a dry run — `cw-ship` accepts `build: false` to plan and park without opening PRs.
- **Read each skill's `SKILL.md`** before running it.
- The everyday loop keeps you in the driver's seat: `cw-ship` fires a notification when it parks a decision, so even a long hands-off run reaches you exactly when a human judgment is needed — and only then.

## Status

Young but usable. The skill contracts are stable enough to build on, and both the everyday and initiative tracks run end to end today. Versioned at `0.1.0`; the one-command packaging is still settling. Issues and ideas welcome.
