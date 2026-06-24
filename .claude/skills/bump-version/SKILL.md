---
name: bump-version
description: Bump every version field in this craftwork-skills repo to one lockstep value so the Claude plugin marketplace serves a new version. Updates the 3 plugin/marketplace manifest fields (.claude-plugin/marketplace.json metadata.version + plugins[].version, .claude-plugin/plugin.json version) and all 6 per-skill skills/*/SKILL.md metadata.version fields together. Trigger when the user wants to cut/bump/release a new version of the suite, e.g. "bump the version", "bump to 0.2.0", "release a new version", "cut a minor/major/patch".
metadata:
  repo-local: true
---

# bump-version

A **repo-local** authoring tool for *this* repo only. It lives in `.claude/skills/`
(a project skill), so it is available when working in a clone of craftwork-skills
but is **never packaged into the marketplace** — the plugin ships `skills/`, not
`.claude/skills/`. Do not move it under `skills/` or it would be published to
consumers alongside the `cw-*` skills.

## Why this exists

Pushing changes to `main` updates the *content* the marketplace serves, but a
consumer only sees an **update available** when the declared version changes.
There are 9 version fields and they must move together:

- `.claude-plugin/marketplace.json` → `metadata.version` and `plugins[0].version`
- `.claude-plugin/plugin.json` → `version`
- `skills/<each>/SKILL.md` → `metadata.version` (6 skills)

The first three drive the marketplace signal; the per-skill six move in lockstep
so the whole suite reports one version.

## Usage

Run the bundled script from the repo (it locates the repo root itself):

```sh
bash .claude/skills/bump-version/bump-version.sh            # minor bump (default)
bash .claude/skills/bump-version/bump-version.sh minor      # 0.1.0 -> 0.2.0
bash .claude/skills/bump-version/bump-version.sh major      # 0.1.0 -> 1.0.0
bash .claude/skills/bump-version/bump-version.sh patch      # 0.1.0 -> 0.1.1
bash .claude/skills/bump-version/bump-version.sh 0.2.0      # explicit target
bash .claude/skills/bump-version/bump-version.sh minor --dry-run   # preview only
```

The argument is either a semver keyword (`major`/`minor`/`patch`, default `minor`)
or an explicit `X.Y.Z`. If the fields are ever out of sync the script warns and
normalizes them all to the target.

## When invoked as a skill

1. Read the user's intent for the bump size (keyword) or exact target. Default to
   a **minor** bump if unspecified.
2. Run `--dry-run` first and show the user the current → target and field count.
3. On confirmation, run for real.
4. Show the diff. Remind the user the bump only takes effect for consumers once it
   lands on `main`: commit, open a PR, merge (squash, per repo convention).
