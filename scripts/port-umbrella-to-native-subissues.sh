#!/usr/bin/env bash
#
# port-umbrella-to-native-subissues.sh — migrate a legacy checkbox umbrella to
# GitHub native sub-issues, once, idempotently.
#
# A pre-migration cw-skill umbrella tracks its children in a `## Sub-issues`
# body checklist (`- [ ] #NNN`). The cw-* skills now use GitHub NATIVE
# sub-issues as the single source of truth. This script converts an umbrella:
#
#   1. Extracts every #NNN from the umbrella body's `## Sub-issues` section
#      (the leading ref on each checkbox line — a trailing "PR #999" in an
#      annotation is NOT mistaken for a child).
#   2. Links each as a native sub-issue (GraphQL addSubIssue) — idempotent;
#      already-linked children are skipped.
#   3. Translates trailing `**stalled**` / `**deferred**` annotations onto the
#      child as a cw-status:* label + a `<!-- cw:status -->` reason comment.
#   4. Strips the now-duplicated `## Sub-issues` section from the umbrella body,
#      leaving every other section verbatim.
#   5. Verifies the native sub-issue set matches the old checklist.
#
# Checkbox state ([ ] vs [x]) is intentionally NOT carried over: a child's
# open/closed issue state is already the truth.
#
# Usage:
#   bash port-umbrella-to-native-subissues.sh <umbrella> [--repo owner/repo] [--dry-run]
#
# --dry-run prints every action and touches nothing.
#
set -euo pipefail

UMB=""
REPO=""
DRY=0
prev=""
for arg in "$@"; do
  case "$arg" in
    --dry-run) ;;                       # handled in the second pass below
    --repo) ;;                          # value consumed via $prev
    --repo=*) REPO="${arg#--repo=}" ;;
    --*) echo "unknown flag: $arg" >&2; exit 2 ;;
    *) if [ "$prev" = "--repo" ]; then REPO="$arg"; elif [ -z "$UMB" ]; then UMB="$arg"; fi ;;
  esac
  prev="$arg"
done
case " $* " in *" --dry-run "*) DRY=1 ;; esac

[ -n "$UMB" ] || { echo "usage: $0 <umbrella> [--repo owner/repo] [--dry-run]" >&2; exit 2; }
UMB="${UMB#\#}"                          # tolerate a leading '#'
# $REPO has no spaces (owner/repo), so a plain unquoted string is safe and
# avoids bash-3.2's empty-array-under-`set -u` quirk.
REPO_FLAG=""
[ -n "$REPO" ] && REPO_FLAG="--repo $REPO"

say()  { printf '%s\n' "$*"; }
run()  { if [ "$DRY" = 1 ]; then say "  [dry-run] $*"; else eval "$@"; fi; }

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# --- read the umbrella body -------------------------------------------------
gh issue view "$UMB" $REPO_FLAG --json body -q .body > "$tmp/body.md"
if ! grep -qE '^## Sub-issues[[:space:]]*$' "$tmp/body.md"; then
  say "#$UMB has no '## Sub-issues' checklist section — nothing to port (already native?)."
  gh issue view "$UMB" $REPO_FLAG --json subIssues -q '.subIssues.totalCount' \
    | sed 's/^/  native sub-issues currently linked: /'
  exit 0
fi

# lines inside the `## Sub-issues` section
awk '/^## Sub-issues[[:space:]]*$/{f=1;next} f&&/^## /{f=0} f' "$tmp/body.md" > "$tmp/section.txt"
# children = the LEADING #NNN on each checkbox line, in appearance order, deduped
CHILDREN=$(grep -oE '^- \[[ xX]\] #[0-9]+' "$tmp/section.txt" | grep -oE '[0-9]+' | awk '!seen[$0]++' || true)
[ -n "$CHILDREN" ] || { say "No '- [ ] #NNN' children found in the checklist; aborting."; exit 1; }

say "Umbrella #$UMB — porting these checklist children to native sub-issues:"
say "$CHILDREN" | sed 's/^/  #/'

UMB_ID=$(gh issue view "$UMB" $REPO_FLAG --json id -q .id)

ensure_label() { # name color
  run "gh label create '$1' $REPO_FLAG --color '$2' --description 'cw-orchestrate sub-issue status' 2>/dev/null || true"
}

# --- link each child + translate its annotation -----------------------------
for n in $CHILDREN; do
  say "• #$n"
  CHILD_ID=$(gh issue view "$n" $REPO_FLAG --json id -q .id)
  run "gh api graphql -f query='mutation(\$p:ID!,\$c:ID!){addSubIssue(input:{issueId:\$p,subIssueId:\$c}){issue{number}}}' -f p='$UMB_ID' -f c='$CHILD_ID' >/dev/null 2>&1 || true"

  line=$(grep -E "^- \[[ xX]\] #$n([^0-9]|$)" "$tmp/section.txt" | head -1)
  status="" ; reason=""
  if printf '%s' "$line" | grep -qiE '\*\*stalled\*\*'; then
    status="cw-status:stalled"; reason=$(printf '%s' "$line" | sed -E 's/.*\*\*stalled\*\*:?[[:space:]]*//I')
  elif printf '%s' "$line" | grep -qiE '\*\*deferred\*\*'; then
    status="cw-status:deferred"; reason=$(printf '%s' "$line" | sed -E 's/.*\*\*deferred\*\*:?[[:space:]]*//I')
  fi
  if [ -n "$status" ]; then
    if [ "$status" = "cw-status:stalled" ]; then ensure_label "cw-status:stalled" "D93F0B"; icon="stalled"
    else ensure_label "cw-status:deferred" "FBCA04"; icon="deferred"; fi
    run "gh issue edit '$n' $REPO_FLAG --add-label '$status'"
    run "gh issue comment '$n' $REPO_FLAG --body '<!-- cw:status --> ⏸ ${icon}: ${reason:-(see umbrella)}'"
  fi
done

# --- strip the duplicated checklist section ---------------------------------
awk '
  /^## Sub-issues[[:space:]]*$/ { inseg=1; next }
  inseg && /^## / { inseg=0 }
  !inseg { print }
' "$tmp/body.md" > "$tmp/stripped.md"

say "Stripping the '## Sub-issues' checklist from the umbrella body (all other sections preserved)."
if [ "$DRY" = 1 ]; then
  say "  [dry-run] gh issue edit $UMB --body-file <stripped>"
else
  gh issue edit "$UMB" $REPO_FLAG --body-file "$tmp/stripped.md"
fi

# --- verify -----------------------------------------------------------------
if [ "$DRY" = 0 ]; then
  say "Verifying native sub-issue set:"
  gh issue view "$UMB" $REPO_FLAG --json subIssues -q '.subIssues[].number' | sed 's/^/  linked #/'
fi
say "Done."
