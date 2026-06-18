# Issue Reconciliation

**GitHub is the system of record.** When a unit of work completes, the issues on GitHub must reflect the true shipped state — not the run logs, not the original plan. Someone reading only GitHub should see exactly what is done and what remains, without consulting the run output.

This is the canonical reconciliation contract. Each execution skill runs it over the issues its run touched, **before** local cleanup (GitHub truth first, local tidiness second):

- **cw-orchestrate** — over the manifest's sub-issues, the umbrella, and the umbrella's parent (Step 7).
- **cw-ship** — over each built feedback issue and anything it references or is tracked by (Step 5).
- **cw-sweep** — over the residuals it triaged and the umbrella they trace to (Step 4).

A run does **not** keep GitHub current on its own: a squash-merge auto-closes an issue only when its PR body carried a `Closes #NNN` keyword, and checklists, parents, descriptions, and cross-references never update themselves.

## The rule — reconcile every issue the run started, touched, or referenced

1. **Close what's resolved, with a safety net.** For each issue whose PR merged, confirm the merge actually closed it (`gh issue view <n> --json state` / `gh pr view <pr> --json closingIssuesReferences`). If it merged green but is still `OPEN` (the PR omitted the keyword), close it: `gh issue close <n> --comment "Merged via PR #<pr>. <one line>"`. **Never** close an issue whose work stalled or whose PR is still open.

2. **Tick checkboxes in trackers.** For every parent / umbrella / milestone that lists the issue as `- [ ] #NNN`, flip it to `- [x]` once the issue is resolved; for items left deferred/stalled, keep them unchecked and annotate the line with the reason so the list reads true. Edit via `gh issue edit <n> --body-file <file>` (a body-file or quoted heredoc preserves backticks and `- [ ]` — never hand-escape).

3. **Consult parents — close them when (and only when) everything under them is done.** If resolving this issue means a parent's children are *all* resolved and nothing is deferred / stalled / a live escalation, close the parent too (`gh issue close <parent> --reason completed --comment "<one-line outcome>"`). Otherwise leave it open and, when useful, post a progress comment so the parent reflects partial completion. Never close a parent that still tracks open work.

4. **Update descriptions to match shipped reality.** When the change diverged from what the issue described — a different approach, a narrower or broader scope, follow-ups split into new issues — edit the issue **body** so its description matches what actually shipped, rather than leaving it describing a plan that didn't happen. The body is the live state; comments are the audit trail. (Don't rewrite history needlessly: only update where the description would now mislead a reader.)

5. **Reconcile cross-references.** Issues this work `Relates to`, `Part of`, mentions, or partially addresses — in the PR body or in the issue's own body — are touched too. Update each as its state now warrants: tick/annotate its tracker line, close it if this work fully resolved it, or post a one-line "addressed by PR #<pr>" so the cross-reference isn't left stale and misleading.

6. **Verify.** Re-read the edited issues and confirm the edits landed and that every remaining open item (issue, checklist line, parent) is genuinely still open work.

## The invariant

When the run ends, **every issue it started, touched, or referenced reflects the true current state on GitHub**: resolved issues closed, trackers ticked, parents closed iff everything under them is done, descriptions matching what shipped, cross-references current. If a reader would be misled by what GitHub shows versus what actually shipped, reconciliation is not finished.
