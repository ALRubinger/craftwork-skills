#!/usr/bin/env bash
#
# link-skills.sh — symlink every skill in this repo into your Claude skills dir.
#
# Walks skills/*/SKILL.md and, for each one, creates a symlink
#   $CLAUDE_SKILLS_DIR/<skill>  ->  <repo>/skills/<skill>
# pointing at the working tree, so edits to a SKILL.md are live the next time
# you invoke it. Idempotent and re-runnable: links that already point at the
# right place are left alone, so adding a new skill is just a re-run — nothing
# goes stale.
#
# This is for the *authoring* machine. On machines that only consume the suite,
# install via the Claude Code plugin marketplace instead (see README).
#
# Usage:
#   bash scripts/link-skills.sh             # link all skills into ~/.claude/skills
#   bash scripts/link-skills.sh --dry-run   # show what it would do, touch nothing
#   bash scripts/link-skills.sh --force     # replace conflicting non-matching links
#   CLAUDE_SKILLS_DIR=/path bash scripts/link-skills.sh   # override target dir
#
set -euo pipefail

DRY=0 ; FORCE=0

die() { echo "error: $*" >&2; exit 1; }
usage() { sed -n '3,18p' "$0" | sed 's/^#\{0,1\} \{0,1\}//'; }

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1; shift ;;
    --force)   FORCE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown argument: $1 (try --help)" ;;
  esac
done

# Repo root is the parent of this script's scripts/ directory.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SKILLS_SRC="$REPO_ROOT/skills"
TARGET_DIR="${CLAUDE_SKILLS_DIR:-$HOME/.claude/skills}"

[ -d "$SKILLS_SRC" ] || die "no skills/ directory under $REPO_ROOT"

run() { if [ "$DRY" -eq 1 ]; then echo "would: $*"; else "$@"; fi; }

[ -d "$TARGET_DIR" ] || run mkdir -p "$TARGET_DIR"

linked=0 ; skipped=0 ; conflicts=0

for skill_md in "$SKILLS_SRC"/*/SKILL.md; do
  [ -e "$skill_md" ] || continue          # no skills yet: nothing to do
  src="$(cd "$(dirname "$skill_md")" && pwd)"
  name="$(basename "$src")"
  link="$TARGET_DIR/$name"

  if [ -L "$link" ]; then
    current="$(readlink "$link")"
    if [ "$current" = "$src" ]; then
      skipped=$((skipped + 1))
      continue                            # already correct
    fi
    if [ "$FORCE" -eq 1 ]; then
      run rm -f "$link"
    else
      echo "conflict: $link -> $current (use --force to replace)" >&2
      conflicts=$((conflicts + 1))
      continue
    fi
  elif [ -e "$link" ]; then
    echo "conflict: $link exists and is not a symlink (leaving it alone)" >&2
    conflicts=$((conflicts + 1))
    continue
  fi

  run ln -s "$src" "$link"
  echo "linked: $name -> $src"
  linked=$((linked + 1))
done

echo "done: $linked linked, $skipped already current, $conflicts conflicts -> $TARGET_DIR"
[ "$conflicts" -eq 0 ] || exit 1
