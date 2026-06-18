#!/usr/bin/env bash
#
# install-scheduler.sh — put the CraftWork cw-ship loop on a schedule with one command.
#
# Detects your OS and wires up the schedule for you: launchd on macOS, a systemd
# user timer (or cron) on Linux. Interactive by default; prompts for the repo,
# a local checkout path, and run times, offering sensible defaults. Re-runnable
# and reversible.
#
# Usage:
#   bash install-scheduler.sh                         # interactive
#   bash install-scheduler.sh --repo owner/repo \
#        --repo-dir ~/code/repo --times 8:13,14:13,20:13 --yes
#   bash install-scheduler.sh --dry-run               # show what it would do, touch nothing
#   bash install-scheduler.sh --uninstall             # remove the schedule
#
set -euo pipefail

WRAPPER="$HOME/bin/cw-ship.sh"
PLIST="$HOME/Library/LaunchAgents/local.cw-ship.plist"
SYSTEMD_DIR="$HOME/.config/systemd/user"
UNIT="cw-ship"                       # systemd unit + cron marker base
DEFAULT_TIMES="8:13,14:13,20:13"

REPO="" ; REPO_DIR="" ; TIMES="" ; ACTION="install" ; ASSUME_YES=0 ; DRY=0

die() { echo "error: $*" >&2; exit 1; }
usage() { sed -n '3,16p' "$0" | sed 's/^#\{0,1\} \{0,1\}//'; }

while [ $# -gt 0 ]; do
  case "$1" in
    --repo)      REPO="${2:-}"; shift 2 ;;
    --repo-dir)  REPO_DIR="${2:-}"; shift 2 ;;
    --times)     TIMES="${2:-}"; shift 2 ;;
    --uninstall) ACTION="uninstall"; shift ;;
    --dry-run)   DRY=1; shift ;;
    -y|--yes)    ASSUME_YES=1; shift ;;
    -h|--help)   usage; exit 0 ;;
    *) die "unknown argument: $1 (try --help)" ;;
  esac
done

OS="$(uname -s)"

# ---------- helpers ----------
parse_remote() { # echo owner/repo from a checkout's origin URL, or nothing
  local url; url="$(git -C "${1:-.}" remote get-url origin 2>/dev/null || true)"
  case "$url" in
    git@*:*/*)       echo "${url#*:}"        | sed 's/\.git$//' ;;
    https://*/*/*)   echo "${url#https://*/}"| sed 's/\.git$//' ;;
  esac
}
pad2() { printf '%02d' "$((10#$1))"; }

writefile() { # writefile PATH   (content on stdin)
  local p="$1"
  if [ "$DRY" = 1 ]; then echo "--- would write $p ---"; cat; echo "--- end $p ---"; echo
  else mkdir -p "$(dirname "$p")"; cat > "$p"; echo "wrote $p"; fi
}
run() { if [ "$DRY" = 1 ]; then echo "+ $*"; else "$@"; fi; }

confirm() {
  { [ "$ASSUME_YES" = 1 ] || [ "$DRY" = 1 ]; } && return 0
  local ans; read -r -p "$1 [y/N]: " ans || true
  case "$ans" in y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}
ask() { # ask VAR "prompt" "default"
  local __var="$1" __prompt="$2" __default="${3:-}" __ans
  [ -n "${!__var:-}" ] && return 0
  if [ -t 0 ]; then read -r -p "$__prompt${__default:+ [$__default]}: " __ans || true; fi
  printf -v "$__var" '%s' "${__ans:-$__default}"
}

resolve_mechanism() {
  case "$OS" in
    Darwin) echo launchd ;;
    Linux)
      if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1
      then echo systemd; else echo cron; fi ;;
    *) die "unsupported OS '$OS'. Use the manual recipes in skills/cw-ship/references/scheduling.md (e.g. Windows Task Scheduler)." ;;
  esac
}

# ---------- uninstall ----------
uninstall() {
  case "$(resolve_mechanism)" in
    launchd)
      [ -f "$PLIST" ] && run launchctl unload "$PLIST" || true
      run rm -f "$PLIST" ;;
    systemd)
      run systemctl --user disable --now "$UNIT.timer" || true
      run rm -f "$SYSTEMD_DIR/$UNIT.timer" "$SYSTEMD_DIR/$UNIT.service"
      run systemctl --user daemon-reload || true ;;
    cron)
      if crontab -l 2>/dev/null | grep -q "# >>> $UNIT >>>"; then
        run bash -c "crontab -l 2>/dev/null | sed '/# >>> $UNIT >>>/,/# <<< $UNIT <<</d' | crontab -"
      fi ;;
  esac
  echo "cw-ship schedule removed. (Left $WRAPPER in place; delete it manually if you no longer want it.)"
}

[ "$ACTION" = uninstall ] && { uninstall; exit 0; }

# ---------- gather inputs ----------
DEF_DIR=""; git rev-parse --show-toplevel >/dev/null 2>&1 && DEF_DIR="$(git rev-parse --show-toplevel)"
ask REPO     "GitHub repo the loop should triage (owner/repo)" "$(parse_remote .)"
ask REPO_DIR "Local checkout of that repo (for git context)"   "${DEF_DIR:-$HOME/path/to/repo}"
ask TIMES    "Run times, comma-separated HH:MM (local)"        "$DEFAULT_TIMES"

[ -n "$REPO" ] || die "repo is required (owner/repo)"
case "$REPO" in */*) : ;; *) die "repo must be 'owner/repo', got '$REPO'" ;; esac
[ -d "$REPO_DIR/.git" ] || echo "warning: '$REPO_DIR' is not a git checkout — the wrapper's git refresh may fail until you clone it there."
for b in claude git gh; do command -v "$b" >/dev/null 2>&1 || echo "warning: '$b' not found on PATH (the wrapper sets a PATH for the scheduler, but verify it covers '$b')."; done

MECH="$(resolve_mechanism)"
echo
echo "Planned cw-ship schedule:"
echo "  repo:       $REPO"
echo "  checkout:   $REPO_DIR"
echo "  times:      $TIMES (local)"
echo "  mechanism:  $MECH"
echo "  wrapper:    $WRAPPER"
echo
confirm "Proceed?" || { echo "aborted."; exit 0; }

# ---------- write the wrapper ----------
writefile "$WRAPPER" <<EOF
#!/usr/bin/env bash
# Generated by craftwork-skills install-scheduler.sh — re-run it to update.
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:\$PATH"   # gh, git, node
[ -s "\$HOME/.nvm/nvm.sh" ] && . "\$HOME/.nvm/nvm.sh"                 # if node is via nvm

REPO="$REPO"
REPO_DIR="$REPO_DIR"

cd "\$REPO_DIR"
git fetch origin main -q && git checkout main -q && git pull -q --ff-only || true

# Retry loop: a headless run can no-op on a transient classifier/backoff blip.
attempt=0
until [ "\$attempt" -ge 4 ]; do
  out="\$(claude -p "/cw-ship \$REPO" 2>&1)" && rc=0 || rc=\$?
  printf '%s\n' "\$out"
  if [ "\$rc" -eq 0 ] && ! printf '%s' "\$out" | grep -qiE 'classifier (briefly )?unavailable|rate.?limit|backoff'; then break; fi
  attempt=\$((attempt + 1)); sleep \$((attempt * 30))
done

# Optional: also execute any umbrellas the loop just filed (idempotent). Uncomment to enable.
# claude -p "/cw-orchestrate \$REPO"
EOF
run chmod +x "$WRAPPER"

# ---------- install the schedule ----------
install_launchd() {
  local dicts="" t h m
  IFS=','; for t in $TIMES; do
    h="$((10#${t%%:*}))"; m="$((10#${t##*:}))"
    dicts+="    <dict><key>Hour</key><integer>$h</integer><key>Minute</key><integer>$m</integer></dict>"$'\n'
  done; unset IFS
  writefile "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>local.cw-ship</string>
  <key>ProgramArguments</key>
    <array><string>/bin/bash</string><string>-lc</string><string>$WRAPPER</string></array>
  <key>StartCalendarInterval</key><array>
$dicts  </array>
  <key>StandardOutPath</key><string>/tmp/cw-ship.out</string>
  <key>StandardErrorPath</key><string>/tmp/cw-ship.err</string>
</dict></plist>
EOF
  run launchctl unload "$PLIST" 2>/dev/null || true
  run launchctl load "$PLIST"
  TEST_CMD="launchctl start local.cw-ship   # logs: tail -f /tmp/cw-ship.out"
}

install_systemd() {
  writefile "$SYSTEMD_DIR/$UNIT.service" <<EOF
[Unit]
Description=CraftWork cw-ship feedback loop
[Service]
Type=oneshot
ExecStart=$WRAPPER
EOF
  local cal="" t
  IFS=','; for t in $TIMES; do cal+="OnCalendar=*-*-* $(pad2 "${t%%:*}"):$(pad2 "${t##*:}"):00"$'\n'; done; unset IFS
  writefile "$SYSTEMD_DIR/$UNIT.timer" <<EOF
[Unit]
Description=Run cw-ship on a schedule
[Timer]
${cal}Persistent=true
[Install]
WantedBy=timers.target
EOF
  run systemctl --user daemon-reload
  run systemctl --user enable --now "$UNIT.timer"
  TEST_CMD="systemctl --user start $UNIT.service   # logs: journalctl --user -u $UNIT.service -f"
}

install_cron() {
  local lines="" t h m
  IFS=','; for t in $TIMES; do
    h="$((10#${t%%:*}))"; m="$((10#${t##*:}))"
    lines+="$m $h * * * $WRAPPER >> \$HOME/.local/state/cw-ship.log 2>&1"$'\n'
  done; unset IFS
  run mkdir -p "$HOME/.local/state"
  local block="# >>> $UNIT >>>"$'\n'"$lines""# <<< $UNIT <<<"
  if [ "$DRY" = 1 ]; then echo "--- would add to crontab ---"; printf '%s\n' "$block"; echo "--- end ---"
  else ( crontab -l 2>/dev/null | sed "/# >>> $UNIT >>>/,/# <<< $UNIT <<</d"; printf '%s\n' "$block" ) | crontab -
    echo "updated crontab"; fi
  TEST_CMD="$WRAPPER   # runs it once now"
}

case "$MECH" in
  launchd) install_launchd ;;
  systemd) install_systemd ;;
  cron)    install_cron ;;
esac

# ---------- report ----------
echo
echo "Done — cw-ship will run at $TIMES (local), triaging $REPO."
echo
echo "Test it now:    $TEST_CMD"
echo "Dry run first:  claude -p \"/cw-ship $REPO\"   (or pass build:false to plan without merging)"
echo "Uninstall:      bash $0 --uninstall"
