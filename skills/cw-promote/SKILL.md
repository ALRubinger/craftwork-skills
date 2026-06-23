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

- **Zero** `cw-target:*` labels ⇒ treat as **already-promoted / no-op**, not a hard error. Either this was never an integration umbrella (cw-orchestrate already lands non-integration umbrellas straight to `main` and closes them) **or** a previous cw-promote run already completed and deleted the label in Step 5. Because the label is deleted last (Step 5's final cleanup), a re-run after a partial failure lands here with the feature already on `main`; reconcile any leftover steps (close the umbrella if still open, reconcile the parent up-link, heal the checkout) idempotently and exit success — never re-merge and never HALT. There is simply nothing left to promote.
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

"Closed" alone does **not** prove a sub-issue's work landed on the integration branch — a sub-issue could have been closed manually, or its PR could have merged to `main` or some other base. So verify mechanically: the proof is a **MERGED PR whose `baseRefName == integration/<slug>` that closes the sub-issue**.

**Why not `closedByPullRequestsReferences`.** GitHub populates the structured issue↔PR closing linkage (both `closedByPullRequestsReferences` on the issue and `closingIssuesReferences` on the PR) **only for PRs that target the default branch**. A PR that merged onto `integration/<slug>` with `Closes #NNN` in its body leaves *both* sides empty, even though it genuinely closed the work — and an integration-branch merge never auto-closes the issue, so cw-orchestrate closes it by hand (its Step 7). Reading the structured linkage would therefore HALT on **every** integration run — the exact scenario this skill exists for. So enumerate the merged PRs based on `integration/<slug>` and match each sub-issue against them, preferring the structured reference when present and falling back to the PR body's closing keyword:

```bash
# Candidate "landed" PRs: merged onto the integration branch.
landed_prs_json=$(gh pr list --base "$branch" --state merged \
  --limit 200 --json number,body,closingIssuesReferences)

fail=0
# `gh issue view --json subIssues` returns a `{nodes, totalCount}` connection
# object on current gh (2.9x+); older builds returned a flat array. The
# `(.nodes // .)` handles both shapes.
mapfile -t subs < <(gh issue view "$umbrella" --json subIssues \
  --jq '(.subIssues.nodes // .subIssues)[].number')
for n in "${subs[@]}"; do
  state=$(gh issue view "$n" --json state --jq '.state')
  if [ "$state" != "CLOSED" ]; then
    echo "BLOCK #$n: still $state (not landed on $branch)"; fail=1; continue
  fi
  # Landed iff some merged PR based on $branch either structurally closes #n
  # (default-branch case) or names it with a closing keyword in its body
  # (integration-branch case, where GitHub omits the structured linkage).
  landed=$(printf '%s' "$landed_prs_json" | jq -r --argjson n "$n" '
    [ .[]
      | select(
          ([.closingIssuesReferences[].number] | index($n))
          or
          ((.body // "")
           | test("(?i)\\b(clos(e|es|ed)|fix(es|ed)?|resolv(e|es|ed))\\b[^#\\n]*#"
                  + ($n|tostring) + "\\b"))
        )
    ] | length')
  if [ "${landed:-0}" -eq 0 ]; then
    echo "BLOCK #$n: no MERGED PR based on $branch closes it"
    fail=1
  fi
done
[ "$fail" -eq 0 ] || { echo "HALT: feature not whole on $branch"; exit 1; }
```

Any sub-issue still open, or with no merged PR based on `integration/<slug>` that closes it, **halts** promotion with a named cause — it is flagged, never silently accepted. A sub-issue whose only closing PR merged to `main` directly means the feature is fragmented across branches; it won't appear among the `--base "$branch"` PRs, so it is caught here.

Then confirm **whole-feature CI is green**. The integration branch is what gets squashed onto `main`, so its assembled state is what must be proven — but **where** that proof lives depends on the repo's CI triggers, so check the branch and defer to the gate that actually runs:

```bash
branch_runs=$(gh run list --branch "$branch" --limit 1 \
  --json status,conclusion,headSha,workflowName)
if [ "$(printf '%s' "$branch_runs" | jq 'length')" -gt 0 ]; then
  # The repo runs CI on the integration branch — require it green now.
  printf '%s' "$branch_runs" | jq -e \
    '.[0] | (.status == "completed" and .conclusion == "success")' >/dev/null \
    || { echo "HALT: latest CI on $branch is not green"; exit 1; }
else
  # The repo's CI does not trigger on integration-branch pushes/PRs (e.g. a
  # workflow gated on `pull_request: branches: [main]` and `push: [main]`).
  # There is nothing to require here — the real whole-feature gate is the
  # integration->main PR's own checks, which Step 4 waits on before merging.
  echo "NOTE: no CI runs on $branch; whole-feature CI is gated on the integration->main PR (Step 4)."
fi
```

When CI **does** run on `integration/<slug>`, a pending, failing, or absent-on-HEAD run halts promotion. When it does **not** (the repo only CIs `main` and PRs based on `main`), the gate moves to Step 4: the `integration/<slug> -> main` PR triggers the same CI on a `main` base, and Step 4 merges only once that PR's checks conclude green. Either way the assembled feature is CI-verified before it lands — never `--admin`-merged blind.

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
# If the repo CIs the integration branch, re-confirm completed/success on the
# new HEAD here (same check as Step 2); otherwise the integration->main PR's
# checks in Step 4 are the gate. Either way, do not proceed on a red branch run.
```

If the main-merge **conflicts**, halt — a headless or unattended context must not pick a side of a conflict (merge-safety [guarantee 6, "No force-resolve, ever"](../cw-orchestrate/references/merge-safety.md)). The operator resolves it on the integration branch, then re-invokes.

### Step 4: Operator-gated atomic squash-merge

This is the **single human checkpoint**, mirroring cw-scope's "confirm before writing shared state" gate. Ask for an explicit **"promote"** confirmation (`AskUserQuestion`; load its schema via `ToolSearch` with `select:AskUserQuestion` if needed) showing:

- the **slug** and target branch `integration/<slug>`,
- the **in-scope sub-issue list** verified in Step 2 (each with the merged PR, based on `integration/<slug>`, that closes it),
- the **CI status**: the branch HEAD's successful run when the repo CIs `integration/<slug>` (Step 3), or a note that the whole-feature gate is the `integration/<slug> → main` PR's own checks, which the merge below waits on.

Only on an explicit confirm, open a PR `integration/<slug> → main` with a conventional-commit title and a Summary / Test-plan body. For repos that don't CI the integration branch, this PR (base `main`) is where the assembled feature's CI runs — so **wait for its blocking checks to conclude and merge only when they are green**, then squash-merge for the **single atomic commit** that represents the entire feature on `main`:

```bash
pr=$(gh pr create --base main --head "$branch" \
  --title "feat(<slug>): land the <feature> integration branch" \
  --body-file <body>)

# This PR's checks are the whole-feature CI gate (especially when the repo does
# not CI the integration branch directly). Wait for them to settle, then read
# the concluded buckets explicitly — do NOT trust `--watch`'s exit code as proof
# of green. A red blocking check is a hard stop; --admin bypasses required
# *review*, never failing *validation*.
gh pr checks "$pr" --watch >/dev/null 2>&1 || true
buckets=$(gh pr checks "$pr" --json bucket --jq '[.[].bucket]' 2>/dev/null || echo '[]')
if printf '%s' "$buckets" | jq -e 'any(.[]; . == "pending")' >/dev/null; then
  echo "HALT: CI still pending on PR #$pr — re-invoke once checks have concluded"; exit 1
fi
if printf '%s' "$buckets" | jq -e 'any(.[]; . == "fail" or . == "cancel")' >/dev/null; then
  echo "HALT: a blocking check failed on PR #$pr — fix before promoting (no --admin override of red CI)"; exit 1
fi

# All blocking checks concluded green (or the repo has no CI at all) — land it.
gh pr merge "$pr" --repo "<owner>/<repo>" --squash --admin --delete-branch
```

Never a merge commit or rebase-merge; never `git checkout main && git merge`. The squash is the whole point: one commit on `main` for the whole feature. The `--admin` flag bypasses the codeowner-**review** gate only; the check-conclusion guard above is what ensures it never lands over red or pending CI.

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

The order matters: every reversible, idempotent step runs **first**, and the **irreversible repo-wide label delete runs last** (item 4). That way a partial-failure re-run still finds the `cw-target:<slug>` label and can re-derive the slug/branch and resume — deleting the label first would strand a half-promoted feature with no single source of truth to re-enter on.

1. **Close the umbrella.** cw-promote owns this close because cw-orchestrate deliberately left the integration umbrella **open** for it (cw-orchestrate's Step 7: "do not close the umbrella … Closing the umbrella and promoting the integration branch is cw-promote's job"). Idempotent — skip if already closed.
   ```bash
   gh issue close "$umbrella" --reason completed \
     --comment "Promoted integration/${slug} to main via PR #${pr} (single squash commit). Feature is live; cw-target:${slug} removed."
   ```
2. **Reconcile the parent up-link** per the reconciliation contract. If the umbrella names a parent (e.g. a milestone `Parent: #35`) that tracks it in a `- [ ] #NNN` body checklist, tick that line by hand and annotate it ("promoted via PR #<pr>"); **never auto-close a human milestone**. If the parent uses native sub-issues, the widget rolls up the umbrella's close on its own — nothing to edit.
3. **Heal the local checkout.** The integration branch is deleted and the feature is on `main`:
   ```bash
   git fetch origin main
   # If the primary checkout (or a worktree) is parked on the now-deleted
   # integration branch, switch it back to main first (untracked files survive).
   git branch -f main origin/main   # when nothing has main checked out;
                                    # else: git -C <checkout> merge --ff-only origin/main
   ```
   Never force-push `main`. Advancing local `main` to `origin/main` is a fast-forward (the squash commit is already on the remote), so no work is lost.
4. **Delete the `cw-target:<slug>` label repo-wide — deliberately last, and irreversible.** The target is done — the single-source-of-truth label is **removed, not mirrored** (no duplicated state). Deleting the label also strips it from every sub-issue that inherited it, leaving no stale target marker. This is the **final** cleanup step precisely because it is the one irreversible action: once the label is gone the slug/branch can no longer be re-derived, so it runs only after every other reconciliation has succeeded. A re-run that reaches Step 1 with zero `cw-target:*` labels treats that as already-promoted (Step 1's no-op path).
   ```bash
   gh label delete "cw-target:${slug}" --yes
   ```

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
- **Closed ≠ landed.** A sub-issue being closed does not prove its work merged onto the integration branch. Step 2 proves it by finding a MERGED PR **based on `integration/<slug>` that closes the sub-issue** — matched via the PR's structured `closingIssuesReferences` when present, else its body's closing keyword. It does **not** read `closedByPullRequestsReferences`: GitHub populates that structured linkage only for default-branch PRs, so an integration-branch merge always leaves it empty and the old check would have HALTed every promote. A closing PR that merged to a different base never appears among the `--base integration/<slug>` PRs, so it is flagged, not accepted.
- **CI gates the merge, wherever it runs.** When the repo CIs `integration/<slug>` directly, Step 2/3 require that branch run green. When it does not (CI only triggers on `main` and PRs based on `main`, the common case), there is no branch run to require — the gate moves to the `integration/<slug> → main` PR, whose checks Step 4 waits on and reads explicitly before the squash. The feature is always CI-verified before it lands; `--admin` bypasses required *review*, never failing or pending *validation*, and `--watch`'s exit code is never trusted as proof of green.
- **Never force-resolve, never force-push `main`.** A re-merge of `main` that conflicts halts (merge-safety guarantee 6); healing the checkout only fast-forwards local `main` to `origin/main`.
- **`gh`/`git` via Bash**, not MCP — matches cw-orchestrate and cw-scope and survives headless contexts.
- **Interactive by design.** Like cw-scope, cw-promote ships no background Workflow and no executable script — the value is the verified, operator-gated atomic landing.
