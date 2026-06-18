# Scheduling cw-ship

`cw-ship` runs unattended: a scheduler fires the skill non-interactively on a timer, it drains the feedback backlog, and it pages you only when a decision is parked.

## The easy way: the installer

From a clone of the repo, run the installer and answer the prompts — it detects your OS and wires up the schedule for you:

```sh
bash scripts/install-scheduler.sh             # interactive (launchd on macOS, systemd or cron on Linux)
bash scripts/install-scheduler.sh --dry-run   # preview everything it would write/run, touch nothing
bash scripts/install-scheduler.sh --uninstall # remove the schedule
```

Non-interactive: `--repo owner/repo --repo-dir ~/code/repo --times 8:13,14:13,20:13 --yes`.

The rest of this file is the **manual** path — what the installer automates — for Windows, for fine-grained control, or to understand what is being set up. Everything uses `claude -p` (Claude Code's headless invocation); for another runtime, substitute its non-interactive command. Replace `<owner>/<repo>` and the checkout path with yours.

## What the schedule relies on

Three guards in `SKILL.md` and the Workflow make unattended runs safe:

1. **Run lock** (SKILL.md Step 1) — `~/.cache/cw-ship/<owner>-<repo>.lock`; overlapping runs exit cleanly.
2. **Per-issue lock** (`feedback:triaging`) — the Workflow labels an issue in-flight so a concurrent run skips it.
3. **Idempotency** — every run re-discovers from live labels (`feedback:new` / `feedback:go`), so a missed or partial run self-heals on the next tick. Re-running is the intended mode, which is what makes the retry loop in the wrapper safe.

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

Why the retry loop: a headless `-p` run has no turn to "resume" into, so a transient classifier / backoff / rate-limit blip can yield a silent no-op exit 0. The run lock + idempotency make re-invoking safe.

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
- **Pause/remove:** `bash scripts/install-scheduler.sh --uninstall`, or remove the unit by hand (`launchctl unload …plist`, `systemctl --user disable --now cw-ship.timer`, or delete the cron block).
- **Stuck run lock:** remove `~/.cache/cw-ship/<owner>-<repo>.lock` if it is older than ~1h with no live run.
- **Stuck `feedback:triaging`:** if a crashed run left an issue labeled `feedback:triaging`, remove that label by hand; the next run re-picks it from `feedback:new` / `feedback:go`.

## Without a local machine

- **GitHub Actions cron.** A scheduled workflow runs the agent in CI — repo-native, runs regardless of any laptop, best for teams. Use `anthropics/claude-code-action` (or your agent's action) on a `schedule:` trigger. The runner needs a token with merge rights, and the bot identity must be allowed to bypass required review.
- **Managed cloud routine** (e.g. Claude Code's `/schedule`). Runs on managed infra, no server or open session. Usually a minimum interval around an hour, and billed.

## Safety, however you schedule it

- Scope the agent's auth to the target repo, and start with a dry run — `cw-ship` accepts `build: false` to plan and park without opening PRs. Do one manual `claude -p "/cw-ship <owner>/<repo>"` and watch it before activating any schedule.
- Never let a headless run fall into an interactive permission prompt; rely on a pre-approved allowlist.
