# Scheduling cw-ship (OPTIONAL)

**`cw-ship` is an on-demand tool.** The expected way to run it is to invoke `/cw-ship <owner>/<repo>` yourself when you want the feedback backlog drained; it then plans, builds + merges the clear items, and pages you only when a decision is parked. It is **not** wired to run automatically, and scheduling it is a deliberate opt-in, not the default.

This file documents that opt-in for the rare case where you genuinely want `cw-ship` firing on a timer (a scheduler runs it non-interactively, it drains the backlog, it pages you on a parked decision). If you only want it on demand, you don't need anything here.

> The one-command installer (`scripts/install-scheduler.sh`) does **not** schedule `cw-ship` — it only schedules `cw-sweep`. To put `cw-ship` on a timer, use the manual per-OS recipes below.

The recipes use `claude -p` (Claude Code's headless invocation); for another runtime, substitute its non-interactive command. Replace `<owner>/<repo>` and the checkout path with yours.

## What the schedule relies on

Two guards in `SKILL.md` and the Workflow make unattended runs safe — and there is **no run lock**, so overlapping scheduled runs (or a manual run during a scheduled one) are fine, not a hazard:

1. **Per-issue atomic claim** (`<!-- cw-ship/claim -->` + `cw-feedback:triaging`) — a run builds an issue only if it owns the claim (earliest non-stale `created_at`, ties by lowest comment id), verified *after* claiming so a snapshot→claim race resolves to one owner. A crashed claim is reclaimed by age (2h, no open PR, no recent update), never by a PID. See [state-machine.md](./state-machine.md) for the full contract. (The old per-repo lockfile was removed: a `$$`-in-a-file lock is meaningless when every Bash call is a fresh ephemeral shell.)
2. **Idempotency** — every run re-discovers from live labels + claims (`cw-feedback:new` / `cw-feedback:go` / crashed `cw-feedback:triaging`), so a missed or partial run self-heals on the next tick. Re-running is the intended mode, which is what makes the retry loop in the wrapper safe — and, because two runs can't both own an issue, a re-invocation that overlaps the prior one cannot double-build.

## Manual setup

### Step 1 — the wrapper (macOS / Linux)

Save to `~/bin/cw-ship.sh` and `chmod +x ~/bin/cw-ship.sh`. It puts the toolchain on PATH (schedulers run with a minimal environment), refreshes a local checkout for git context, and runs the loop headlessly with a retry loop for transient backoff.

```sh
#!/usr/bin/env bash
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"   # gh, git, node
[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh"                   # if node is via nvm

REPO="<owner>/<repo>"
REPO_DIR="$HOME/path/to/<repo>"

cd "$REPO_DIR"
git fetch origin main -q && git checkout main -q && git pull -q --ff-only || true

attempt=0
until [ "$attempt" -ge 4 ]; do
  out="$(claude -p "/cw-ship $REPO" 2>&1)" && rc=0 || rc=$?
  printf '%s\n' "$out"
  if [ "$rc" -eq 0 ] && ! printf '%s' "$out" | grep -qiE 'classifier (briefly )?unavailable|rate.?limit|backoff'; then break; fi
  attempt=$((attempt + 1)); sleep $((attempt * 30))
done

# Optional: also execute any umbrellas the loop just filed (idempotent). Uncomment to enable.
# claude -p "/cw-orchestrate $REPO"
```

The optional trailing step wires cw-ship's output straight into cw-orchestrate's **repo-scan mode**. `/cw-orchestrate <owner>/<repo>` (a slug, not a `#number`) discovers **every** OPEN issue carrying `cw-umbrella:ready` — including the ones this very run just filed — and runs each through the hands-off plan → review → work → serial-merge flow **with no interactive sweep** (the label is the upstream human approval; see cw-orchestrate's [readiness-sweep.md](../../cw-orchestrate/references/readiness-sweep.md#two-gate-postures)). It is **opt-in**, same posture as everything else in this file: leave it commented for on-demand-only, uncomment to have the scheduled cw-ship tick also drain ready umbrellas.

Why it is safe to fire on every tick:

- **Idempotent + crash-safe.** cw-orchestrate keeps `cw-umbrella:ready` on an umbrella until it is **fully resolved** (every sub-issue closed) — only then does it strip the label as a terminal reconciliation step. A crashed or partial run leaves the umbrella not-fully-resolved, so the label persists and the next scan re-picks and re-attempts; per-node idempotency (already-merged sub-issues skip) makes the re-run self-healing.
- **No double-run on an in-flight umbrella.** Because the label persists through an in-flight run, repo-scan mode applies a **live-state in-flight guard**: an umbrella already being orchestrated (an open PR closing one of its sub-issues, or a sub-issue mid-work) is skipped this tick. Overlapping scans stay off each other without a lock. The guard is **best-effort, not a lock**: it reads signals a running orchestration emits, so the **launch→first-PR window** — after a run launches but before its first PR opens — is invisible to it. That window is safe **only because these recipes run a single-process sequential loop**: one scheduled invocation at a time, each umbrella carried to completion before the next fires. Do **not** run two schedulers against the same repo, and do **not** fire a manual `/cw-orchestrate <owner>/<repo>` while the scheduled loop is mid-run — concurrent schedulers or an overlapping human run stay unsupported (the guard cannot close that race).
- **A sub-issue that needs a decision is parked, not guessed.** Headless, cw-orchestrate cannot ask; a would-be-clarify sub-issue is parked (`cw-status:stalled` + a needs-input comment) and excluded, so the run never plans against an unresolved fork.

Why the retry loop: a headless `-p` run has no turn to "resume" into, so a transient classifier / backoff / rate-limit blip can yield a silent no-op exit 0. Per-issue claims + idempotency make re-invoking safe — a retry that overlaps a still-running attempt can't double-build, because each issue has exactly one claim owner.

**Permissions (Claude Code):** do NOT pass `--permission-mode` and do NOT use `--dangerously-skip-permissions`. `claude -p` reads `~/.claude/settings.json` (`defaultMode: auto` + your allow-list), which should already cover the skill's `gh`/`git`/`gh api` operations. Overriding the mode re-introduces blocking prompts — fatal headless. For other runtimes, ensure the agent can run `gh`/`git` non-interactively without prompting.

### macOS — launchd

Save `~/Library/LaunchAgents/local.cw-ship.plist` (runs 08:13 / 14:13 / 20:13 local; pick any unique `Label`):

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
launchctl load ~/Library/LaunchAgents/local.cw-ship.plist   # activate
launchctl start local.cw-ship                                # run once now (test); logs: tail -f /tmp/cw-ship.out
launchctl unload ~/Library/LaunchAgents/local.cw-ship.plist  # pause
```

launchd runs the job even if the scheduled time was missed while the machine slept, survives reboots, and needs no open session.

### Linux — cron

Add three daily entries with `crontab -e`:

```cron
13 8,14,20 * * * $HOME/bin/cw-ship.sh >> $HOME/.local/state/cw-ship.log 2>&1
```

```sh
crontab -l            # verify
$HOME/bin/cw-ship.sh  # run once now (test)
```

### Linux — systemd timer

`~/.config/systemd/user/cw-ship.service`:

```ini
[Unit]
Description=CraftWork cw-ship feedback loop
[Service]
Type=oneshot
ExecStart=%h/bin/cw-ship.sh
```

`~/.config/systemd/user/cw-ship.timer`:

```ini
[Unit]
Description=Run cw-ship on a schedule
[Timer]
OnCalendar=*-*-* 08:13:00
OnCalendar=*-*-* 14:13:00
OnCalendar=*-*-* 20:13:00
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

### Windows — Task Scheduler

`cw-ship.cmd` at `%USERPROFILE%\bin\cw-ship.cmd` (ensure `git`, `node`, and `claude` are on the system PATH):

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

## Operating the schedule

- **Run once (test):** the per-OS test command above (`launchctl start` / `systemctl --user start` / run the wrapper directly).
- **Pause/remove:** remove the unit by hand (`launchctl unload …plist`, `systemctl --user disable --now cw-ship.timer`, or delete the cron block). The installer does not manage a `cw-ship` schedule, so there is nothing for it to uninstall here. (To stop running it entirely, just stop invoking `/cw-ship` — that is the on-demand default.)
- **Stuck `cw-feedback:triaging`:** no manual action needed — a crashed claim is reclaimed automatically once it ages past `CLAIM_TIMEOUT` (2h) with no open PR and no recent update. (There is no lockfile to clear; the old `~/.cache/cw-ship/*.lock` scheme was removed.)
- **Stuck `cw-feedback:triaging`:** if a crashed run left an issue labeled `cw-feedback:triaging`, remove that label by hand; the next run re-picks it from `cw-feedback:new` / `cw-feedback:go`.

## Without a local machine

- **GitHub Actions cron.** A scheduled workflow runs the agent in CI — repo-native, runs regardless of any laptop, best for teams. Use `anthropics/claude-code-action` (or your agent's action) on a `schedule:` trigger. The runner needs a token with merge rights, and the bot identity must be allowed to bypass required review.
- **Managed cloud routine** (e.g. Claude Code's `/schedule`). Runs on managed infra, no server or open session. Usually a minimum interval around an hour, and billed.

## Safety, however you schedule it

- Scope the agent's auth to the target repo, and start with a dry run — `cw-ship` accepts `build: false` to plan and park without opening PRs. Do one manual `claude -p "/cw-ship <owner>/<repo>"` and watch it before activating any schedule.
- Never let a headless run fall into an interactive permission prompt; rely on a pre-approved allowlist.
