#!/usr/bin/env bash
# Bump every version field in the craftwork suite to one lockstep value.
#
# Touches 9 fields:
#   - .claude-plugin/marketplace.json  -> metadata.version + plugins[].version (2)
#   - .claude-plugin/plugin.json       -> version (1)
#   - skills/*/SKILL.md                -> metadata.version (6, one per skill)
#
# The 3 plugin/marketplace fields are what drive the Claude marketplace
# "update available" signal; the 6 per-skill fields move with them so the
# whole suite reports one version. This is a repo-local authoring tool — it
# lives under .claude/skills/ and is NOT packaged into the marketplace (which
# only ships skills/), so consumers never see it.
#
# Usage:
#   bump-version.sh [major|minor|patch|X.Y.Z] [--dry-run]
#
#   no arg        -> minor bump of the current version
#   major|minor|patch -> computed semver bump
#   X.Y.Z         -> explicit target
#   --dry-run     -> print what would change, touch nothing
set -euo pipefail

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
cd "$ROOT"

DRY_RUN=0
ARG=""
for a in "$@"; do
  case "$a" in
    --dry-run) DRY_RUN=1 ;;
    -*) echo "error: unknown flag: $a" >&2; exit 2 ;;
    *)
      if [[ -n "$ARG" ]]; then echo "error: unexpected extra argument: $a" >&2; exit 2; fi
      ARG="$a"
      ;;
  esac
done
[[ -z "$ARG" ]] && ARG="minor"

MARKETPLACE=".claude-plugin/marketplace.json"
PLUGIN=".claude-plugin/plugin.json"
SKILL_FILES=()
while IFS= read -r line; do SKILL_FILES+=("$line"); done < <(find skills -mindepth 2 -maxdepth 2 -name SKILL.md | sort)

# --- gather current versions across all 9 fields ----------------------------
declare -a FOUND=()
collect() { # file regex
  while IFS= read -r v; do FOUND+=("$1=$v"); done < <(grep -oE "$2" "$1" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+')
}
collect "$MARKETPLACE" '"version":[[:space:]]*"[0-9]+\.[0-9]+\.[0-9]+"'
collect "$PLUGIN"      '"version":[[:space:]]*"[0-9]+\.[0-9]+\.[0-9]+"'
for f in "${SKILL_FILES[@]}"; do
  collect "$f" '^[[:space:]]*version:[[:space:]]*"[0-9]+\.[0-9]+\.[0-9]+"'
done

if [[ ${#FOUND[@]} -eq 0 ]]; then
  echo "error: found no version fields — are you in the craftwork-skills repo?" >&2
  exit 1
fi

# distinct set of current values
DISTINCT=()
while IFS= read -r line; do DISTINCT+=("$line"); done < <(printf '%s\n' "${FOUND[@]}" | sed 's/.*=//' | sort -u)
CURRENT="${DISTINCT[0]}"
if [[ ${#DISTINCT[@]} -ne 1 ]]; then
  echo "warning: version fields are out of sync (${DISTINCT[*]}); normalizing all to the new target." >&2
fi

# --- compute target ---------------------------------------------------------
if [[ "$ARG" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  TARGET="$ARG"
else
  IFS=. read -r MA MI PA <<<"$CURRENT"
  case "$ARG" in
    major) TARGET="$((MA + 1)).0.0" ;;
    minor) TARGET="${MA}.$((MI + 1)).0" ;;
    patch) TARGET="${MA}.${MI}.$((PA + 1))" ;;
    *) echo "error: argument must be major|minor|patch or an explicit X.Y.Z (got: $ARG)" >&2; exit 2 ;;
  esac
fi

echo "current: ${CURRENT}   ->   target: ${TARGET}   (${#FOUND[@]} fields across $((2 + ${#SKILL_FILES[@]})) files)"
if [[ "$TARGET" == "$CURRENT" && ${#DISTINCT[@]} -eq 1 ]]; then
  echo "nothing to do — already at ${TARGET}."
  exit 0
fi

# --- apply ------------------------------------------------------------------
edit() { # file perl-expr
  if [[ "$DRY_RUN" -eq 1 ]]; then
    perl -ne "$2 and print \"  would set: \$_\"" "$1" || true
  else
    perl -i -pe "$2" "$1"
  fi
}

JSON_EXPR='s/("version":\s*)"[0-9]+\.[0-9]+\.[0-9]+"/${1}"'"$TARGET"'"/g'
SKILL_EXPR='s/^(\s*version:\s*)"[0-9]+\.[0-9]+\.[0-9]+"/${1}"'"$TARGET"'"/'

edit "$MARKETPLACE" "$JSON_EXPR"
edit "$PLUGIN" "$JSON_EXPR"
for f in "${SKILL_FILES[@]}"; do
  edit "$f" "$SKILL_EXPR"
done

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "(dry run — no files changed)"
  exit 0
fi

echo "bumped ${#FOUND[@]} fields to ${TARGET}:"
printf '  %s\n' "$MARKETPLACE" "$PLUGIN" "${SKILL_FILES[@]}"
echo
echo "next: review the diff, commit, and merge to main so the marketplace serves ${TARGET}."
