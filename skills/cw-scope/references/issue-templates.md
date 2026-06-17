# Issue Templates + Creation Recipe

The shapes below are what an `cw-orchestrate` readiness sweep expects to read. Fill every section; an empty section is a gap the sweep will stop on.

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

## Sub-issues
- [ ] #__SUB1__ — <title>
- [ ] #__SUB2__ — <title>
- [ ] ...

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

GitHub issue numbers don't exist until creation, so create then backfill cross-references. Write each body to a scratch file and create with `--body-file` — never hand-escape backticks or `- [ ]`.

1. **Write body files** to a scratch dir (e.g. `mktemp -d`). Use placeholder tokens for not-yet-known numbers: `#__UMBRELLA__`, `#__SUB1__` … `#__SUBn__`.

2. **Create the umbrella first** and capture its number:
   ```bash
   UMB=$(gh issue create --title "<umbrella title>" --body-file umbrella.md [--label <label>] | grep -oE '[0-9]+$')
   ```

3. **Create each sub-issue.** Replace `#__UMBRELLA__` in the sub-issue files with `$UMB` before creating, then capture each number:
   ```bash
   sed -i '' "s/__UMBRELLA__/$UMB/g" sub*.md       # macOS sed; GNU: sed -i
   S1=$(gh issue create --title "<sub1 title>" --body-file sub1.md | grep -oE '[0-9]+$')
   # ...repeat for S2..Sn
   ```

4. **Backfill cross-references.** Replace `#__SUBn__` placeholders across the umbrella body and any sub-issue that references a sibling, then re-upload the corrected bodies:
   ```bash
   sed -i '' "s/__SUB1__/$S1/g; s/__SUB2__/$S2/g; ..." umbrella.md sub2.md ...
   gh issue edit "$UMB" --body-file umbrella.md
   gh issue edit "$S2"  --body-file sub2.md
   # verify none remain:
   grep -l "__SUB\|__UMBRELLA__" *.md || echo clean
   ```

5. **Link to the parent**, mirroring its convention (detected in SKILL.md Step 0):
   - **Body-checklist parent** (most common for milestone issues): fetch the parent body, append a checklist line under the right section, re-upload:
     ```bash
     gh issue view <parent> --json body --jq .body > parent.md
     # append: - [ ] <umbrella title> (#<UMB>) — <one line>
     gh issue edit <parent> --body-file parent.md
     ```
   - **Native sub-issue parent:** create the native relationship via the GraphQL `addSubIssue` mutation (gh has no first-class command as of 2.94). Only do this if the parent actually uses native sub-issues.

6. **Verify** the tree: `gh issue view <UMB>` shows the filled checklist and deps; each sub-issue shows its `Parent:` line; the parent shows the umbrella link.

## Detecting the parent's linking convention

```bash
gh issue view <parent> --json subIssues --jq '.subIssues.totalCount'   # 0 ⇒ body-checklist convention
gh issue view <parent> --json body --jq .body | grep -oE '#[0-9]+'      # children referenced inline ⇒ checklist
```

A `totalCount` of 0 with inline `#NNN` references in the body means the parent tracks children by checklist — mirror that. A non-zero `totalCount` means native sub-issues — use `addSubIssue`.
