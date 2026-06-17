# Scheduling the Feedback Loop

This skill is built to run unattended. It uses the same **local cron** pattern as `renovate-shepherd` (see that skill's `references/scheduling.md` for the full reasoning behind the three patterns and the permission/retry lessons). This file gives the cw-ship-specific recipe.

The reliability guards the schedule depends on are in `SKILL.md` and the Workflow:

1. **Run lock** (SKILL.md Step 1) — `~/.cache/cw-ship/<owner>-<repo>.lock`; overlapping runs exit cleanly.
2. **Per-issue lock** (`feedback:triaging`) — the Workflow labels an issue in-flight so a second run skips it.
3. **Idempotency** — every run re-discovers from live labels (`feedback:new` / `feedback:go`), so a missed or partial run self-heals next tick. Re-running is the intended mode.

## The chosen pattern — launchd → headless `claude -p`, 3×/day

A macOS LaunchAgent invokes a wrapper that loads the toolchain and runs the skill headlessly. 3×/day (8:13 / 14:13 / 20:13 local, off the :00 mark) so feedback filed through the day is acted on within hours, not the next day.

### Wrapper: `~/bin/cw-ship.sh`

The live, authoritative copy is at `~/bin/cw-ship.sh`. Shape:

```sh
#!/usr/bin/env bash
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"   # gh, git
[ -s "$HOME/.nvm/nvm.sh" ] && source "$HOME/.nvm/nvm.sh"              # node (nvm)
cd "$HOME/git/ALRubinger/aileron"
git fetch origin main --quiet && git checkout main --quiet && git pull --quiet --ff-only

# Retry loop (the renovate dud-run lesson): the auto-mode classifier can be
# briefly unavailable and `-p` has no turn to "resume" into, so re-invoke on a
# non-zero exit or a backoff sentinel, up to 4 times. Lock + idempotency make
# retries safe.
attempt=0
until [ "$attempt" -ge 4 ]; do
  out="$(claude -p "/cw-ship ALRubinger/aileron" 2>&1)" && rc=0 || rc=$?
  printf '%s\n' "$out"
  if [ "$rc" -eq 0 ] && ! printf '%s' "$out" | grep -qiE 'classifier (briefly )?unavailable|rate.?limit|backoff'; then
    break
  fi
  attempt=$((attempt + 1)); sleep $((attempt * 30))
done

# Optional second step: execute any umbrellas the loop just filed. orchestrate is
# idempotent, so this is safe to run every tick; it no-ops when nothing is ready.
# claude -p "/cw-orchestrate ALRubinger/aileron"   # uncomment to auto-execute large feedback
```

**Permissions:** do NOT pass `--permission-mode` and do NOT use `--dangerously-skip-permissions`. `claude -p` reads `~/.claude/settings.json` (`defaultMode: auto` + allow-list), which already covers this skill's `gh issue/pr/label`, `git push/fetch/checkout/rebase/worktree`, and `gh api` operations. Overriding the mode would re-introduce blocking prompts for plumbing — fatal headless. Making it a `--dangerously-skip-permissions` bot is a security-posture change you must opt into explicitly.

### LaunchAgent: `~/Library/LaunchAgents/ai.aileron.cw-ship.plist`

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>ai.aileron.cw-ship</string>
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

Load with `launchctl load ~/Library/LaunchAgents/ai.aileron.cw-ship.plist`. launchd reliably runs the job even if the scheduled time was missed while asleep, survives reboots, and needs no open session.

## Operating the schedule

- **Run now (test):** `launchctl start ai.aileron.cw-ship`, then `tail -f /tmp/cw-ship.out`.
- **Pause:** `launchctl unload ~/Library/LaunchAgents/ai.aileron.cw-ship.plist`.
- **Stuck lock:** remove `~/.cache/cw-ship/<owner>-<repo>.lock` if older than ~1h with no live run.
- **Stuck `feedback:triaging`:** if a crashed run left an issue labeled `feedback:triaging`, remove that label by hand; the next run re-picks it from `feedback:new` / `feedback:go`.

## The other patterns (not chosen)

The same three alternatives `renovate-shepherd` documents apply here — **A1** `CronCreate` (in-session, durable, 7-day expiry), **B** GitHub Actions cron (repo-native, needs a merge-capable bot identity), **C** Cloud Routine via `/schedule` (managed, ≥1h interval, billed). Local launchd was chosen for the same reason: the operator wants it on their own machine with no open session required. See renovate-shepherd's scheduling.md for the trade-offs.
