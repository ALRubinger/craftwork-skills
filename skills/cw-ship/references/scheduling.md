# Scheduling cw-ship

`cw-ship` is built to run unattended: a scheduler fires the skill non-interactively on a timer, it drains the feedback backlog, and it pages you only when a decision is parked. This file is the full worked recipe for the most self-contained option — **local cron via macOS launchd** — plus a brief on the alternatives. The README's "Scheduling the autonomous loops" section has the high-level menu.

Everything below uses `claude -p` (Claude Code's headless invocation). For another agent runtime, substitute its non-interactive command for `claude -p "/cw-ship ..."`; the wrapper, scheduler, and safety notes are otherwise identical.

## What the schedule relies on

Three guards in `SKILL.md` and the Workflow make unattended runs safe:

1. **Run lock** (SKILL.md Step 1) — `~/.cache/cw-ship/<owner>-<repo>.lock`; overlapping runs exit cleanly.
2. **Per-issue lock** (`feedback:triaging`) — the Workflow labels an issue in-flight so a concurrent run skips it.
3. **Idempotency** — every run re-discovers from live labels (`feedback:new` / `feedback:go`), so a missed or partial run self-heals on the next tick. Re-running is the intended mode, which is also what makes the retry loop below safe.

## Local cron via launchd (worked example)

A macOS LaunchAgent invokes a wrapper that loads the toolchain and runs the skill headlessly. The example runs 3×/day (08:13 / 14:13 / 20:13 local, off the :00 mark so a fleet of jobs doesn't all hit the API at once) so feedback filed through the day is acted on within hours. On Linux, the same wrapper drops into a cron entry (`13 8,14,20 * * *`) or a systemd timer unchanged.

### Wrapper: `~/bin/cw-ship.sh`

Parameterize the top three lines for your repo, then make it executable (`chmod +x`):

```sh
#!/usr/bin/env bash
set -euo pipefail

# --- configure for your repo ---
REPO="<owner>/<repo>"               # the GitHub repo cw-ship triages
REPO_DIR="$HOME/path/to/<repo>"     # a local checkout of it (for git context)
BRANCH="main"
# --------------------------------

# Put the toolchain on PATH for a non-interactive (login-less) scheduler context.
# Shown for macOS Homebrew + nvm; adjust for your OS and node install.
export PATH="/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"   # gh, git
[ -s "$HOME/.nvm/nvm.sh" ] && source "$HOME/.nvm/nvm.sh"              # node (nvm)

cd "$REPO_DIR"
git fetch origin "$BRANCH" --quiet && git checkout "$BRANCH" --quiet && git pull --quiet --ff-only

# Retry loop: a headless `-p` run has no turn to "resume" into, so a transient
# classifier / backoff / rate-limit blip can yield a silent no-op exit 0.
# Re-invoke on a non-zero exit OR a backoff sentinel, up to 4 times. The run
# lock + idempotency make retries safe.
attempt=0
until [ "$attempt" -ge 4 ]; do
  out="$(claude -p "/cw-ship $REPO" 2>&1)" && rc=0 || rc=$?
  printf '%s\n' "$out"
  if [ "$rc" -eq 0 ] && ! printf '%s' "$out" | grep -qiE 'classifier (briefly )?unavailable|rate.?limit|backoff'; then
    break
  fi
  attempt=$((attempt + 1)); sleep $((attempt * 30))
done

# Optional: execute any umbrellas the loop just filed (idempotent; no-ops when
# nothing is ready). Uncomment to make umbrella-sized feedback hands-off too.
# claude -p "/cw-orchestrate $REPO"
```

**Permissions (Claude Code):** do NOT pass `--permission-mode` and do NOT use `--dangerously-skip-permissions`. `claude -p` reads `~/.claude/settings.json` (`defaultMode: auto` + your allow-list), which should already cover the skill's `gh issue/pr/label`, `git push/fetch/checkout/rebase/worktree`, and `gh api` operations. Overriding the mode re-introduces blocking prompts for plumbing — fatal in a headless run. Turning it into a `--dangerously-skip-permissions` bot is a security-posture change you should opt into explicitly, not by default. **For other runtimes:** ensure the agent can run `gh`/`git` non-interactively without prompting, via whatever allowlist mechanism it provides.

### LaunchAgent: `~/Library/LaunchAgents/local.cw-ship.plist`

Pick any unique `Label`; `local.cw-ship` is a neutral default.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>local.cw-ship</string>
  <key>ProgramArguments</key>
    <array><string>/bin/bash</string><string>-lc</string>
    <string>$HOME/bin/cw-ship.sh</string></array>
  <key>StartCalendarInterval</key>
    <array>
      <dict><key>Hour</key><integer>8</integer><key>Minute</key><integer>13</integer></dict>
      <dict><key>Hour</key><integer>14</integer><key>Minute</key><integer>13</integer></dict>
      <dict><key>Hour</key><integer>20</integer><key>Minute</key><integer>13</integer></dict>
    </array>
  <key>StandardErrorPath</key><string>/tmp/cw-ship.err</string>
  <key>StandardOutPath</key><string>/tmp/cw-ship.out</string>
</dict></plist>
```

Load with `launchctl load ~/Library/LaunchAgents/local.cw-ship.plist`. launchd runs the job even if the scheduled time was missed while the machine slept, survives reboots, and needs no open session.

### Operating the schedule

- **Run now (test):** `launchctl start local.cw-ship`, then `tail -f /tmp/cw-ship.out`. Start with a dry run by editing the wrapper to call `/cw-ship $REPO` with `build: false` semantics (see SKILL.md) until you trust the routing.
- **Pause:** `launchctl unload ~/Library/LaunchAgents/local.cw-ship.plist`.
- **Stuck run lock:** remove `~/.cache/cw-ship/<owner>-<repo>.lock` if it is older than ~1h with no live run.
- **Stuck `feedback:triaging`:** if a crashed run left an issue labeled `feedback:triaging`, remove that label by hand; the next run re-picks it from `feedback:new` / `feedback:go`.

## The other patterns, briefly

Local launchd is the most self-contained, but two alternatives fit different needs:

- **In-session durable cron** (e.g. Claude Code's `CronCreate`). Fires a recurring prompt while an agent REPL is idle. No wrapper or OS scheduler needed, but it only runs while a session is open and some implementations auto-expire after a few days.
- **GitHub Actions cron.** A scheduled workflow runs the agent in CI — repo-native, runs regardless of any laptop, best for teams. The runner needs a token with merge rights, and the bot identity must be allowed to bypass required review. Good when you want the automation to live in the repo.
- **Managed cloud routine** (e.g. Claude Code's `/schedule`). Runs on managed infra with no server or open session. Usually enforces a minimum interval (around an hour) and is billed. A solid middle ground between local cron and CI.

Whichever you choose, the safety rules are the same: scope the agent's auth to the target repo, start with a dry run, and never let a headless run fall into an interactive permission prompt.
