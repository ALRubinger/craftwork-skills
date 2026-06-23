# Worktree Discipline

The execution skills (`cw-orchestrate`, `cw-ship`, `cw-sweep`) hold one invariant about the target repo's local checkout:

> **All implementation happens in a git worktree. The primary checkout's default branch is a pure fast-forward mirror of `origin` and never receives a local commit.**

This file is the canonical statement of that contract and how to enforce it. It is referenced from each execution skill's post-run cleanup step.

---

## Why

A direct `git commit` on the **primary checkout's default branch** creates a local-only commit. The moment the same work reaches `origin` through a squash-merge (the normal PR flow), that local commit becomes the **un-squashed twin** of the squash commit: same change, different SHA, present locally but not on `origin`. Local and remote `main` have now both advanced with different commits — the textbook "divergent branches," and a plain `git pull` refuses to fast-forward.

Run many agents at once and this compounds: the primary checkout ends up parked on stray branches with a `main` that won't pull. The fix is not to *heal* the divergence repeatedly — it is to make it **structurally impossible** by never committing in the primary checkout.

## How the skills uphold it

- **Every code-writing subagent runs with `isolation: 'worktree'`** — `cw-orchestrate` work + autofix, `cw-ship` build, `cw-sweep` autofix. Implementation happens on a feature branch inside a `wf_<runId>-NN` worktree, never on the primary checkout.
- **Merges are server-side** (`gh pr merge --squash --admin --delete-branch`); the local default branch is only ever advanced by `git fetch` / `git pull --ff-only` / `git merge --ff-only`.
- **The post-run cleanup heals the primary checkout** — `cw-ship` Step 5, `cw-sweep` Step 5, `cw-orchestrate` Step 8 remove the run's worktrees (merge-state gated) and fast-forward the primary checkout's default branch back to `origin`. This holds on **every** run, including `cw-orchestrate`'s integration-target runs (`cw-target:<slug>`): the primary checkout always heals to `<defaultBranch>` by fast-forward, never to `integration/<slug>`. The integration branch is advanced separately, in a dedicated worktree — never by parking the primary checkout on it — so the fast-forward-mirror invariant above is never broken to chase a non-default merge target.

So the skills' own flows never pollute the primary checkout. The remaining risk is **other** agents — interactive sessions, ad-hoc tooling — that skip a worktree and commit in place.

## The backstop: a pre-commit hook in the target repo

To enforce the invariant against any agent (not just these skills), install a `pre-commit` hook **in the target repo** (the repo being worked on, e.g. the one passed as `repo`) that refuses commits made in the primary checkout. Linked worktrees have a git-dir under `.../worktrees/<name>`; the primary checkout does not — that is the discriminator.

`.githooks/pre-commit`:

```sh
#!/bin/sh
# Refuse commits in the PRIMARY working tree — all work must happen in a worktree,
# so the default branch only ever fast-forwards from origin.
# A linked worktree's git-dir differs from the common git-dir; the primary
# checkout's two are identical. Comparing them is path-name agnostic (a repo that
# happens to live under a dir named "worktrees" won't fool a glob).
gitdir="$(git rev-parse --absolute-git-dir)"
commondir="$(git rev-parse --git-common-dir)"
case "$commondir" in /*) ;; *) commondir="$(CDPATH= cd -- "$commondir" && pwd)" ;; esac
[ "$gitdir" != "$commondir" ] && exit 0   # linked worktree → allowed
[ -n "$ALLOW_PRIMARY_COMMIT" ] && exit 0
branch="$(git symbolic-ref --quiet --short HEAD 2>/dev/null || echo DETACHED)"
cat >&2 <<MSG
✗ Refusing to commit in the primary checkout (branch: $branch).
  Work in a git worktree:  git worktree add ../<name> -b <branch>
  Deliberate one-off:      ALLOW_PRIMARY_COMMIT=1 git commit ...
MSG
exit 1
```

Activate it once per clone (git cannot auto-enable committed hooks):

```sh
git config core.hooksPath .githooks
```

The hook is committed to the **target** repo so it is portable (survives re-clone, shared across all that repo's worktrees) rather than living in one machine's local config. It allows commits in linked worktrees, so every skill subagent flow is unaffected; it blocks only the primary checkout. A rare deliberate primary-checkout commit bypasses with `ALLOW_PRIMARY_COMMIT=1`.

This is enforcement, not advice: the heal step restores the primary checkout *after* the fact, but the hook is what stops the pollution from happening in the first place.
