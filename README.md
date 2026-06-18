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

A loop is just a slash command. To run one unattended, have any agent runtime execute it **non-interactively, on a timer**. Nothing below is Claude-specific beyond the `claude -p` invocation; any runtime that can run a skill headlessly plus any scheduler gives you the loop. `cw-ship` is the one that wants a schedule (it is the continuous backlog drainer); `cw-orchestrate` and `cw-sweep` run on demand, so you do not need to schedule them.

Replace `<owner>/<repo>` and the checkout path with yours throughout.

### Step 1 — the wrapper (macOS / Linux)

Save this to `~/bin/cw-ship.sh` and `chmod +x ~/bin/cw-ship.sh`. It puts the toolchain on PATH (schedulers run with a minimal environment), refreshes a local checkout for git context, and runs the loop headlessly.

```sh
#!/usr/bin/env bash
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"   # gh, git, node
[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh"                   # if node is via nvm

REPO="<owner>/<repo>"
REPO_DIR="$HOME/path/to/<repo>"

cd "$REPO_DIR"
git fetch origin main -q && git checkout main -q && git pull -q --ff-only
claude -p "/cw-ship $REPO"
```

A hardened version — with a retry loop for transient backoff and an optional `cw-orchestrate` follow-up step — is in [`skills/cw-ship/references/scheduling.md`](skills/cw-ship/references/scheduling.md). For a non-Claude runtime, swap `claude -p "/cw-ship $REPO"` for that agent's non-interactive command.

### Step 2 — register it with your OS scheduler

**macOS — launchd.** Save `~/Library/LaunchAgents/local.cw-ship.plist` (runs 08:13 / 14:13 / 20:13 local):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>local.cw-ship</string>
  <key>ProgramArguments</key>
    <array><string>/bin/bash</string><string>-lc</string><string>$HOME/bin/cw-ship.sh</string></array>
  <key>StartCalendarInterval</key><array>
    <dict><key>Hour</key><integer>8</integer><key>Minute</key><integer>13</integer></dict>
    <dict><key>Hour</key><integer>14</integer><key>Minute</key><integer>13</integer></dict>
    <dict><key>Hour</key><integer>20</integer><key>Minute</key><integer>13</integer></dict>
  </array>
  <key>StandardOutPath</key><string>/tmp/cw-ship.out</string>
  <key>StandardErrorPath</key><string>/tmp/cw-ship.err</string>
</dict></plist>
```

```sh
launchctl load ~/Library/LaunchAgents/local.cw-ship.plist   # activate the schedule
launchctl start local.cw-ship                                # run once now (test); logs: tail -f /tmp/cw-ship.out
launchctl unload ~/Library/LaunchAgents/local.cw-ship.plist  # pause
```

**Linux — cron.** Add three daily entries with `crontab -e`:

```cron
13 8,14,20 * * * $HOME/bin/cw-ship.sh >> $HOME/.local/state/cw-ship.log 2>&1
```

```sh
crontab -l            # verify it is installed
$HOME/bin/cw-ship.sh  # run once now (test)
```

**Linux — systemd timer.** Create `~/.config/systemd/user/cw-ship.service`:

```ini
[Unit]
Description=cw-ship feedback loop
[Service]
Type=oneshot
ExecStart=%h/bin/cw-ship.sh
```

and `~/.config/systemd/user/cw-ship.timer`:

```ini
[Unit]
Description=Run cw-ship three times a day
[Timer]
OnCalendar=*-*-* 08,14,20:13:00
Persistent=true
[Install]
WantedBy=timers.target
```

```sh
systemctl --user daemon-reload
systemctl --user enable --now cw-ship.timer   # activate
systemctl --user start cw-ship.service         # run once now (test)
journalctl --user -u cw-ship.service -f        # logs
```

**Windows — Task Scheduler.** Save a wrapper to `%USERPROFILE%\bin\cw-ship.cmd` (ensure `git`, `node`, and `claude` are on the system PATH):

```bat
@echo off
cd /d %USERPROFILE%\path\to\<repo>
git fetch origin main -q && git checkout main -q && git pull -q --ff-only
claude -p "/cw-ship <owner>/<repo>"
```

Register one task per run time (`schtasks /sc daily` fires once a day):

```bat
schtasks /create /tn "cw-ship-am"  /tr "%USERPROFILE%\bin\cw-ship.cmd" /sc daily /st 08:13
schtasks /create /tn "cw-ship-mid" /tr "%USERPROFILE%\bin\cw-ship.cmd" /sc daily /st 14:13
schtasks /create /tn "cw-ship-pm"  /tr "%USERPROFILE%\bin\cw-ship.cmd" /sc daily /st 20:13
schtasks /run    /tn "cw-ship-am"     :: run once now (test)
schtasks /delete /tn "cw-ship-am" /f  :: remove
```

### Without a local machine

**GitHub Actions cron (repo-native).** A scheduled workflow runs the agent in CI — best for teams, or when you do not want the loop tied to one machine. Use [`anthropics/claude-code-action`](https://github.com/anthropics/claude-code-action) (or your agent's equivalent action) on a `schedule:` trigger. The runner needs a token with merge rights, and the bot identity must be allowed to bypass required review.

**Managed cloud routine.** If your platform offers scheduled agent runs (e.g. Claude Code's `/schedule`), point one at `/cw-ship <owner>/<repo>`. These usually enforce a minimum interval (around an hour) and are billed.

### Safety, however you schedule it

- These skills perform real merges. **Scope the agent's auth to the target repo** and start with a dry run — `cw-ship` accepts `build: false` to plan and park without opening PRs. Do one manual `claude -p "/cw-ship <owner>/<repo>"` and watch it before you activate any schedule.
- In a headless run, **do not override the permission mode in a way that re-introduces interactive prompts** — a prompt with no human to answer it hangs the loop. Rely on a pre-approved allowlist instead.
- The everyday loop pages you (`cw-ship` fires a notification when it parks a decision), so an unattended schedule still keeps you in the loop exactly when a human judgment is needed — and only then.

## Status

Early. Versioned at `0.1.0`. The skill contracts are stable enough to use; the packaging for one-command install is still settling. Issues and ideas welcome.
