# Issue Templates + Creation Recipe

The shapes below are what an `cw-orchestrate` readiness sweep expects to read. Fill every section; an empty section is a gap the sweep will stop on.

## The three-tier model: milestone → umbrella → sub-issue

Work nests in three tiers, and the tiers are **not** the same kind of object:

- **Sub-issue** — a single orchestrate-able unit of work (one PR). Tracked as a GitHub **native sub-issue** of its umbrella.
- **Umbrella** — an initiative that fans out into sub-issues. Tracks its children as GitHub **native sub-issues** (the sub-issue widget is the single source of truth for the child set and their state — never a body checklist). An umbrella may itself be a native sub-issue of a higher umbrella.
- **Milestone** — a human-curated roadmap checkpoint that groups umbrellas/issues across a theme (e.g. "v4: containerized runtime"). A milestone is **deliberately a hand-maintained `- [ ] #NNN` checklist, not native sub-issues** — its thematic grouping, per-line annotations, dated scope notes, and readiness flags are load-bearing and have **no native-sub-issue equivalent**. The native widget can hold a flat parent↔child set; it cannot hold "this child shipped via #1037 but #987 was re-parented to v5, and the whole *Pillar 2* theme is done." That curation is the milestone's reason to exist, so it stays a checklist.

`cw-scope` and `cw-orchestrate` own the **umbrella** and **sub-issue** tiers natively. A milestone is a tier *above* the umbrella — usually a human-owned tracker the skills link *up* into (see "Detecting the parent's linking convention") and reconcile against, not one they create or auto-close. The schema below records its shape so the skills read and update it faithfully.

## Milestone body

A milestone is a human roadmap checkpoint. The skills **read and reconcile** it; they do not create or auto-close it. The shape below is the recurring structure of a real milestone (grounded in `ALRubinger/aileron#747` and its successor `#1065`) — present so a skill linking an umbrella up into a milestone, or ticking a resolved child's line, knows where each piece lives.

```markdown
**Predecessor:** #<prev milestone>      <!-- omit on the first milestone -->
**Successor:** #<next milestone>         <!-- omit on the latest milestone -->

## Goal
<What this milestone delivers, in roadmap terms.>

**<name> is done when** <a single observable acceptance line — the "done when"
condition that closes the milestone.>

> **Scope note (YYYY-MM-DD):** <a dated narrowing/widening of scope. Milestones
> accrete these as the roadmap shifts; each is dated so the history is legible.
> Supersedes/defers prior decisions explicitly, citing issue numbers.>

## <Theme A — e.g. Runtime foundation>
- [x] <shipped item> (#NNN) — merged via #NNN
- [x] <shipped item, re-parented> (#NNN) — re-parented to #<other milestone>
- [ ] <remaining item> (#NNN) — *needs brainstorm/plan (<what's unresolved>)*

## <Theme B — e.g. Pillar 1 …>
- [x] <item> (#NNN)
- [ ] <item> (#NNN)

## Foundations            <!-- existing work later milestones build on -->
- <prior-milestone work this one assumes; usually links back to #<predecessor>.>

## Out of scope
- <what this milestone deliberately excludes; may cite a deferral issue.>

---
## Requirements (embedded)
<Embedded roadmap/requirements content, same embedding rule as the umbrella.>
```

**Annotation grammar** (the load-bearing per-line text native sub-issues can't hold):

- `— merged via #NNN` — the child shipped via that PR.
- `— re-parented to #NNN` — the child moved to another milestone (cite where).
- `— *needs brainstorm/plan*` (optionally with a parenthetical of what's unresolved) — the child is a known-but-unscoped roadmap item, not yet orchestrate-able.

The checkbox state (`- [x]` / `- [ ]`), the **thematic section** a line sits in, the **dated scope notes**, and these annotations are the milestone's curation. Preserve them on every edit; never flatten them into a native parent↔child link.

## Umbrella body

```markdown
**Parent:** #<parent>            <!-- omit if standalone -->

## Why
<Human-centric motivation: the problem, why now, what it unblocks. A teammate
should understand the initiative from this alone. Plain prose, no jargon.>

## Resolved decisions
| Decision | Choice |
|----------|--------|
| <fork> | <chosen option + one-line rationale; quote any exact strings verbatim> |
| ... | ... |

<!-- Sub-issues are tracked as GitHub NATIVE sub-issues (the issue's sub-issue
     widget), not a body checklist. Create them and link with `addSubIssue` per
     the creation recipe below; do not list them here — the native widget is the
     single source of truth for the child set, their titles, and their state. -->

## Recommended dependencies (for the orchestrate readiness sweep)
- #__SUB2__ `depends_on` #__SUB1__ (<why — logical, not file-overlap>)
- #__SUBn__ is independent.
- Forms a DAG; no cycles.

## Acceptance (umbrella-level)
- <observable, checkable conditions that mean the whole initiative is done>

## Out of scope / deferred
- <what this umbrella explicitly does not do>

---
## Requirements (embedded)
<Embed the brainstorm/requirements content here — see "Embedding requirements" below.>
```

## Embedding requirements (don't link a path readers can't reach)

A GitHub issue is read on github.com, where a repo-relative path like
`docs/brainstorms/...md` is **not** a working link and the file is invisible if
it lives only on an unmerged branch or a local worktree. So **embed the
requirements content into the umbrella body** rather than just citing the path:

- Take the brainstorm/requirements doc, strip its YAML frontmatter, and paste the
  body under an `## Requirements (embedded)` section at the bottom of the umbrella.
  Demote its top `#` heading to `##` so it nests cleanly.
- If the same doc defines **multiple** umbrellas (e.g. a v5 + v6 split), embed the
  full requirements once into the lead umbrella and have the others point to it by
  issue number (`Requirements: embedded in #<lead>`), not by file path.
- Only cite a path *in addition* to embedding, and only when the doc is already on
  the **default branch** (browsable on github.com). A path on a feature branch or
  worktree is a dead reference — never the sole carrier of the requirements.

The test: a reader who opens the issue on github.com with no checkout must be able
to read the full requirements from the issue alone.

## Sub-issue body

```markdown
**Parent:** #__UMBRELLA__ (<umbrella title>)

## What this is
<1–3 sentences: the work, in the user's framing.>

## Resolved decisions
- <decision from preflight, with chosen option; quote exact strings verbatim>
- ...

## Constraints (repo-family)
- <pulled from CLAUDE.md / AGENTS.md — e.g. spec is source of truth + regen
  command; approval gating per ADR-NNNN; idempotency flag per ADR-NNNN;
  conventional commits; squash-merge; coverage bar; docs writing voice;
  no backwards-compat shims.>

## Pointers
- <repo-relative files / patterns the plan should mirror>
- <related ADRs, prior PRs>

## Acceptance
- <observable conditions, including any required regression test>

## Dependency            <!-- omit if independent -->
Depends on #__SUBn__ (<why>).
```

Keep implementation design out of these bodies **except** where a decision is the point (a kept abstraction seam, a spec-first ordering, a decided error string). The planner owns *how*.

## Creation recipe

GitHub issue numbers don't exist until creation, so create then backfill cross-references. Write each body to a scratch file and create with `--body-file` — never hand-escape backticks.

1. **Write body files** to a private scratch dir so nothing lands in the checkout: `D="$(mktemp -d)"`, then write each body to `"$D/umbrella.md"`, `"$D/sub1.md"`, … Use placeholder tokens for not-yet-known numbers: `#__UMBRELLA__`, `#__SUB1__` … `#__SUBn__`.

2. **Create the umbrella first** and capture its number and GraphQL node id (the node id is what native linking needs):
   ```bash
   UMB=$(gh issue create --title "<umbrella title>" --body-file "$D/umbrella.md" [--label <label>] | grep -oE '[0-9]+$')
   UMB_ID=$(gh issue view "$UMB" --json id -q .id)
   # Stamp the umbrella's own state label — this umbrella's scope was approved via the
   # interactive brainstorm + decision-preflight, so it is cleared to orchestrate.
   # Create the label lazily/idempotently, then apply it.
   gh label create cw-umbrella:ready --color 5319E7 \
     --description "Umbrella cleared and waiting for orchestration; scope human-approved upstream" 2>/dev/null || true
   gh issue edit "$UMB" --add-label cw-umbrella:ready
   ```
   Stamping `cw-umbrella:ready` marks the umbrella as cleared for orchestration — it is the umbrella's **own state label**, a single authoritative "ready" marker consumed read-only by cw-orchestrate, **not** a mirror of the native sub-issue graph. It is distinct from the human-owned milestone/roadmap tier *above* the umbrella. The separate `[--label <label>]` on the create is optional and applies **only** if the repo has a label dedicated specifically to umbrellas (orthogonal to `cw-umbrella:ready`). Do **not** apply a milestone/roadmap-tier label (e.g. a `milestone` label) — per the three-tier model above a milestone is a human-owned tier *above* the umbrella that these skills read and reconcile but never create. If no umbrella-specific label exists, that is fine; the native sub-issues identify the umbrella structurally and `cw-umbrella:ready` carries its state.

3. **Create each sub-issue.** Replace `#__UMBRELLA__` in the sub-issue files with `$UMB` before creating, then capture each number:
   ```bash
   sed -i '' "s/__UMBRELLA__/$UMB/g" "$D"/sub*.md   # macOS sed; GNU: sed -i
   S1=$(gh issue create --title "<sub1 title>" --body-file "$D/sub1.md" | grep -oE '[0-9]+$')
   # ...repeat for S2..Sn
   ```

4. **Link each sub-issue to the umbrella as a native sub-issue.** This *is* the parent↔child relationship — there is no body checklist. `gh` has no first-class command (as of 2.94), so use the GraphQL `addSubIssue` mutation with node ids:
   ```bash
   for S in "$S1" "$S2" "..."; do
     CHILD_ID=$(gh issue view "$S" --json id -q .id)
     gh api graphql -f query='mutation($p:ID!,$c:ID!){ addSubIssue(input:{issueId:$p, subIssueId:$c}){ issue{ number } } }' \
       -f p="$UMB_ID" -f c="$CHILD_ID" >/dev/null
   done
   ```
   Order matters: `addSubIssue` appends, so add them in the reading order you want the widget to show.

5. **Backfill sibling cross-references.** Replace `#__SUBn__` placeholders in the umbrella's `## Recommended dependencies` section and in any sub-issue `## Dependency` line, then re-upload the corrected bodies:
   ```bash
   sed -i '' "s/__SUB1__/$S1/g; s/__SUB2__/$S2/g; ..." "$D/umbrella.md" "$D/sub2.md" ...
   gh issue edit "$UMB" --body-file "$D/umbrella.md"
   gh issue edit "$S2"  --body-file "$D/sub2.md"
   # verify none remain:
   grep -l "__SUB\|__UMBRELLA__" "$D"/*.md || echo clean
   ```

6. **Link the umbrella up to its own parent** (only if it is a child of an existing milestone/epic), mirroring *that parent's* convention — see "Detecting the parent's linking convention" below. This is the one place a `- [ ]` checklist may still be written: into a human milestone we don't own.

7. **Verify** the tree: `gh issue view <UMB> --json subIssues` lists every sub-issue; each sub-issue shows its `Parent:` line and appears in the umbrella's sub-issue widget; the umbrella itself appears under its own parent.

## Detecting the parent's linking convention (umbrella → its own parent)

This applies **only** to linking the umbrella *up* into an existing parent you don't own. A cw-skill umbrella always tracks its **own** sub-issues natively (Step 4) — that is not a choice to detect.

```bash
gh issue view <parent> --json subIssues --jq '.subIssues.totalCount'   # >0 ⇒ native sub-issues
gh issue view <parent> --json body --jq .body | grep -oE '#[0-9]+'      # inline #NNN refs ⇒ body-checklist milestone
```

A non-zero `totalCount` means the parent uses native sub-issues — link with `addSubIssue` (umbrella as the child, same mutation as Step 4). A `totalCount` of 0 with inline `#NNN` references means a human milestone that tracks children by checklist — append a `- [ ] <umbrella title> (#<UMB>)` line to its body and re-upload, mirroring what's there.

## Porting a legacy checkbox umbrella to native sub-issues

A pre-migration umbrella tracks its children in a `## Sub-issues` body checklist (`- [ ] #NNN`). Convert it once so there is a single source of truth — the native widget — and no stale checklist. `scripts/port-umbrella-to-native-subissues.sh <umbrella>` automates the mechanical core; the recipe it follows:

1. **Extract the listed children.** Pull every `#NNN` from the `## Sub-issues` section of the umbrella body (`gh issue view <umbrella> --json body -q .body`). The checkbox state is **not** carried over — a child's open/closed issue state is already the truth; `[x]` on an open issue was drift the migration drops.

2. **Link each as a native sub-issue.** For each `#NNN`, run the Step 4 `addSubIssue` mutation (umbrella node id as parent, child node id as child). `addSubIssue` is idempotent enough to re-run — a child already linked just errors harmlessly; ignore those.

3. **Translate trailing annotations to the native model.** A line like `- [ ] #984 — **stalled**: <cause>, PR #NNN open` or `— **deferred**: <why>` carried per-child status the checklist could hold but native links can't. Move it onto the child: `gh issue edit #984 --add-label cw-status:stalled` (or `cw-status:deferred`) and post a `<!-- cw:status -->` comment with the reason text. A line with no annotation and a closed issue needs nothing; an open, unannotated line is just in-flight work.

4. **Strip the `## Sub-issues` section** from the umbrella body and re-upload (`gh issue edit <umbrella> --body-file <stripped>`). Leave every other section (Why, Resolved decisions, Recommended dependencies, Acceptance, Out of scope, Requirements, residual follow-ups) verbatim — only the duplicated checklist goes.

5. **Verify** `gh issue view <umbrella> --json subIssues` lists exactly the children the old checklist did, and the body no longer contains a `## Sub-issues` checklist.
