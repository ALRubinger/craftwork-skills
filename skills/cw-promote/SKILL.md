---
name: cw-promote
description: Once a cw-target:<slug> umbrella's whole feature is proven on its integration/<slug> branch, atomically squash-promote that branch into main in one commit, then close the umbrella, delete the cw-target:<slug> label, reconcile the parent up-link, and heal the local checkout. Trigger when the user wants to promote, land, or squash an integration branch into main and finish the integration umbrella.
metadata:
  version: "0.1.0"
  triggers:
    - promote.?(the)?.?integration.?branch
    - squash.?promote
    - (land|merge).?(the)?.?integration.?(branch)?.?(into|to).?main
    - promote.?#?\d+
    - finish.?(the)?.?integration.?umbrella
---

# cw-promote

Atomically land a proven `integration/<slug>` branch onto `main` as a **single squash commit**, then tear down the target state.

This skill is the **closing bookend** of the integration-targeting track. [`cw-scope`](../cw-scope/SKILL.md) marks an umbrella as a target by putting a `cw-target:<slug>` label on it (its [integration-branch targeting convention](../cw-scope/references/issue-templates.md#integration-branch-targeting-cw-targetslug)); [`cw-orchestrate`](../cw-orchestrate/SKILL.md) lands each sub-issue's PR onto `integration/<slug>` and — deliberately — **does not close the integration umbrella** (it heals the checkout to `integration/<slug>` and leaves the umbrella open "for cw-promote (#39)"). cw-promote is what finishes the job: once the whole feature is proven on the integration branch, it merges that branch into `main` in one atomic squash commit, closes the umbrella, **deletes** the `cw-target:<slug>` label, reconciles the parent up-link, and heals the local checkout.

The three skills share a vocabulary on purpose: the `cw-target:<slug>` label is the **single source of truth** for the target across all of them — cw-scope offers/applies it, cw-orchestrate reads it to derive `integration/<slug>`, and cw-promote reads it one last time and then removes it. There is no body field, no per-sub-issue label, no mirrored state.

## When to Use

Use when an integration umbrella's **whole feature is proven** on `integration/<slug>` — every in-scope sub-issue's PR has merged **onto that branch** and whole-feature CI on the branch is green — and you want it landed on `main` atomically, e.g. "promote the integration branch for #39", "squash integration/agent-auth into main", "finish the agent-auth integration umbrella".

Do **not** use for:
- A **non-integration** umbrella (no `cw-target:<slug>` label). cw-orchestrate already lands those sub-issues straight to the default branch and closes the umbrella itself — there is nothing to promote.
- A **mid-flight** integration umbrella where sub-issues are still open or haven't all merged onto `integration/<slug>`. cw-promote verifies completeness and halts if the feature isn't whole — it does not partially land.

## Prerequisites

### Required tools
- `gh` (GitHub CLI) — verify `gh auth status`.
- `git`.

### Required state
- A GitHub umbrella issue carrying **exactly one** `cw-target:<slug>` label, with its sub-issues' PRs already merged onto `integration/<slug>`.
- Standing PR-shepherd authorization for this repo family: squash-merge with `--admin`, branch-deletion verification, and the rule that `main` is **never** force-pushed. See your repo's merge conventions (`AGENTS.md` / `CLAUDE.md`).

### Reference files
cw-promote ships no references of its own; it links the contracts that already govern the integration track. The skill is fully executable from `SKILL.md` alone.

- [cw-orchestrate/references/merge-safety.md](../cw-orchestrate/references/merge-safety.md) — the merge-safety guarantees, including **guarantee 6 ("No force-resolve, ever")** that this skill cites when a re-merge of `main` conflicts.
- [cw-orchestrate/references/issue-reconciliation.md](../cw-orchestrate/references/issue-reconciliation.md) — the shared reconciliation contract used to close the umbrella and reconcile its parent up-link.
- [cw-scope/references/issue-templates.md#integration-branch-targeting-cw-targetslug](../cw-scope/references/issue-templates.md#integration-branch-targeting-cw-targetslug) — the `cw-target:<slug>` convention and the deterministic slug → `integration/<slug>` derivation.

## Workflow

### Step 0: Load repository instructions

Before anything, search for `AGENTS.md` / `CLAUDE.md` in the target repo and load merge guidance: **squash-merge** with `--admin`, **branch-deletion verification** on the remote, conventional-commit titles, and the **default branch is `main`** (never force-pushed). The whole point of this skill — one atomic squash commit representing the entire feature — depends on honoring these.

### Step 1: Resolve the umbrella and derive the target

**Argument:** `<umbrella>` (required — the integration umbrella's issue number or URL).

Read the umbrella's labels and find its `cw-target:*` label — this is the **single source of truth** for the target:

```bash
umbrella="$1"   # e.g. 39
mapfile -t targets < <(gh issue view "$umbrella" --json labels \
  --jq '.labels[].name | select(startswith("cw-target:"))')
```

- **Zero** `cw-target:*` labels ⇒ this is **not** an integration umbrella — halt. cw-orchestrate already lands non-integration umbrellas straight to `main` and closes them; there is nothing to promote.
- **More than one** `cw-target:*` label ⇒ halt and name the conflicting labels. cw-promote does not guess which target was intended; the operator removes the extra label and re-invokes (mirrors cw-orchestrate's Step 1 abort).
- **Exactly one** ⇒ derive deterministically: strip the `cw-target:` prefix to get `slug`, then `branch=integration/<slug>`. The slug is a git-ref-safe segment by construction (cw-scope mints it that way); an empty/whitespace slug is malformed — hard-stop, never fall back to `main`.

Confirm the branch exists on the remote:

```bash
slug="${targets[0]#cw-target:}"
[ -n "$slug" ] || { echo "HALT: empty cw-target slug on #$umbrella"; exit 1; }
branch="integration/${slug}"
git fetch origin main
[ -n "$(git ls-remote --heads origin "$branch")" ] \
  || { echo "HALT: $branch does not exist on origin"; exit 1; }
```

### Step 2: Verify the feature is whole (concrete merged-onto-integration check)

"Closed" alone does **not** prove a sub-issue's PR landed on the integration branch — a sub-issue could have been closed manually, or its PR could have merged to `main` or some other base. So verify mechanically. Enumerate the in-scope sub-issues, and for **each** one require its closing PR is `MERGED` **and** its `baseRefName == integration/<slug>`:

```bash
fail=0
mapfile -t subs < <(gh issue view "$umbrella" --json subIssues \
  --jq '.subIssues[].number')
for n in "${subs[@]}"; do
  state=$(gh issue view "$n" --json state --jq '.state')
  if [ "$state" != "CLOSED" ]; then
    echo "BLOCK #$n: still $state (not merged onto $branch)"; fail=1; continue
  fi
  # Find the PR(s) that closed it and assert base + merge state.
  mapfile -t prs < <(gh issue view "$n" --json closedByPullRequestsReferences \
    --jq '.closedByPullRequestsReferences[].number')
  landed=0
  for pr in "${prs[@]}"; do
    read -r prstate base < <(gh pr view "$pr" --json state,baseRefName \
      --jq '"\(.state) \(.baseRefName)"')
    if [ "$prstate" = "MERGED" ] && [ "$base" = "$branch" ]; then landed=1; fi
  done
  if [ "$landed" -ne 1 ]; then
    echo "BLOCK #$n: no MERGED PR with base $branch (closing PRs: ${prs[*]:-none})"
    fail=1
  fi
done
[ "$fail" -eq 0 ] || { echo "HALT: feature not whole on $branch"; exit 1; }
```

Any sub-issue still open, or whose closing PR merged to a **different** base, **halts** promotion with a named cause — it is flagged, never silently accepted. A sub-issue whose closing PR merged to `main` directly means the feature is fragmented across branches; resolve that before promoting.

Then confirm **whole-feature CI on the integration branch is green** — the integration branch is what actually gets squashed onto `main`, so its latest run is the proof the assembled feature works:

```bash
gh run list --branch "$branch" --limit 1 \
  --json status,conclusion,headSha,workflowName
# require status == "completed" && conclusion == "success" on the branch HEAD
```

A pending, failing, or absent run on `integration/<slug>` halts promotion.

### Step 3: Re-confirm green against fresh `main`

Before landing, absorb any drift on `main` once more so the squash represents the feature merged with the latest base. Merge `main` into `integration/<slug>` (on a scratch worktree so the primary checkout's branches are never touched), push, and re-confirm CI green on the branch:

```bash
git fetch origin main "$branch"
wt=".cw-promote/refresh-${slug}"
git worktree add --force "$wt" "origin/${branch}"
if git -C "$wt" merge --no-edit "origin/main"; then
  git -C "$wt" push origin "HEAD:${branch}"
else
  git -C "$wt" merge --abort
  git worktree remove --force "$wt"
  echo "HALT: merging main into $branch conflicts — operator must resolve"
  exit 1   # never force-resolve (merge-safety guarantee 6)
fi
git worktree remove --force "$wt"
# re-run CI on $branch and require completed/success again before Step 4
```

If the main-merge **conflicts**, halt — a headless or unattended context must not pick a side of a conflict (merge-safety [guarantee 6, "No force-resolve, ever"](../cw-orchestrate/references/merge-safety.md)). The operator resolves it on the integration branch, then re-invokes.

### Step 4: Operator-gated atomic squash-merge

This is the **single human checkpoint**, mirroring cw-scope's "confirm before writing shared state" gate. Ask for an explicit **"promote"** confirmation (`AskUserQuestion`; load its schema via `ToolSearch` with `select:AskUserQuestion` if needed) showing:

- the **slug** and target branch `integration/<slug>`,
- the **in-scope sub-issue list** verified in Step 2 (each with its merged closing PR),
- the **green-CI evidence** from Step 3 (the branch HEAD's successful run).

Only on an explicit confirm, open a PR `integration/<slug> → main` with a conventional-commit title and a Summary / Test-plan body, then squash-merge it for the **single atomic commit** that represents the entire feature on `main`:

```bash
pr=$(gh pr create --base main --head "$branch" \
  --title "feat(<slug>): land the <feature> integration branch" \
  --body-file <body>)
gh pr merge "$pr" --repo "<owner>/<repo>" --squash --admin --delete-branch
```

Never a merge commit or rebase-merge; never `git checkout main && git merge`. The squash is the whole point: one commit on `main` for the whole feature.

Verify the merge landed and the branch is gone:

```bash
gh pr view "$pr" --json state --jq '.state'   # require "MERGED"
# Remote branch must be deleted; if --delete-branch left it (e.g. run from a
# worktree where gh's local cleanup failed), delete it explicitly.
[ -z "$(git ls-remote --heads origin "$branch")" ] \
  || git push origin --delete "$branch"
```

### Step 5: Cleanup and reconcile

With the feature on `main`, tear down the target state per the shared [issue-reconciliation contract](../cw-orchestrate/references/issue-reconciliation.md):

1. **Close the umbrella.** cw-promote owns this close because cw-orchestrate deliberately left the integration umbrella **open** for it (cw-orchestrate's Step 7: "do not close the umbrella … Closing the umbrella and promoting the integration branch is cw-promote's job").
   ```bash
   gh issue close "$umbrella" --reason completed \
     --comment "Promoted integration/${slug} to main via PR #${pr} (single squash commit). Feature is live; cw-target:${slug} removed."
   ```
2. **Delete the `cw-target:<slug>` label repo-wide.** The target is done — the single-source-of-truth label is **removed, not mirrored** (no duplicated state). Deleting the label also strips it from every sub-issue that inherited it, leaving no stale target marker.
   ```bash
   gh label delete "cw-target:${slug}" --yes
   ```
3. **Reconcile the parent up-link** per the reconciliation contract. If the umbrella names a parent (e.g. a milestone `Parent: #35`) that tracks it in a `- [ ] #NNN` body checklist, tick that line by hand and annotate it ("promoted via PR #<pr>"); **never auto-close a human milestone**. If the parent uses native sub-issues, the widget rolls up the umbrella's close on its own — nothing to edit.
4. **Heal the local checkout.** The integration branch is deleted and the feature is on `main`:
   ```bash
   git fetch origin main
   # If the primary checkout (or a worktree) is parked on the now-deleted
   # integration branch, switch it back to main first (untracked files survive).
   git branch -f main origin/main   # when nothing has main checked out;
                                    # else: git -C <checkout> merge --ff-only origin/main
   ```
   Never force-push `main`. Advancing local `main` to `origin/main` is a fast-forward (the squash commit is already on the remote), so no work is lost.

### Step 6: Report

Summarize the outcome:
- the **single squash commit / PR** that landed `integration/<slug>` on `main` (with the link),
- the **closed umbrella**,
- the **deleted** `cw-target:<slug>` label,
- the **reconciled parent line** (ticked checklist entry, or native-widget rollup),
- the **healed checkout** (local `main` fast-forwarded; integration branch gone).

## Key Notes

- **Operator-gated atomic squash is the whole point.** The entire feature lands on `main` as **one** squash commit, only after an explicit operator "promote" (Step 4) — the single human checkpoint, mirroring cw-scope's confirm-before-writing-shared-state gate. Never a merge commit, never a rebase-merge, never `git checkout main && git merge`.
- **The label is the single source of truth — and it is deleted on completion.** cw-promote reads `cw-target:<slug>` to derive both the slug and the branch `integration/<slug>`, then removes it. No body field, no per-sub-issue labels, no mirrored state (honors no-duplicated-state).
- **cw-promote is the only thing that closes an integration umbrella.** cw-orchestrate deliberately leaves it open on a target run; this skill is the closing bookend that closes it after the feature is live on `main`.
- **Closed ≠ landed.** A sub-issue being closed does not prove its PR merged onto the integration branch — Step 2's mechanical `state==MERGED && baseRefName==integration/<slug>` check is what proves the feature is whole. A closing PR that merged to a different base is flagged, not accepted.
- **Never force-resolve, never force-push `main`.** A re-merge of `main` that conflicts halts (merge-safety guarantee 6); healing the checkout only fast-forwards local `main` to `origin/main`.
- **`gh`/`git` via Bash**, not MCP — matches cw-orchestrate and cw-scope and survives headless contexts.
- **Interactive by design.** Like cw-scope, cw-promote ships no background Workflow and no executable script — the value is the verified, operator-gated atomic landing.
