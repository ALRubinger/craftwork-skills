// Canonical, pure, unit-tested merge-CI classification for cw-ship.
//
// cw-ship keeps its OWN canonical copy of these helpers (the same way it keeps
// its own claim.mjs / triage.mjs rather than importing from cw-orchestrate): a
// Workflow scripts in compatible harnesses may auto-run their body on evaluation and have
// no filesystem/module access at runtime, so workflow.js can neither import this
// module nor be imported by a Node test. This file is the tested source of
// truth; workflow.js inlines a byte-for-byte mirror that tests/mirror.test.mjs
// enforces. The function bodies are a verbatim mirror of cw-orchestrate's
// merge-ci.mjs so the two skills share one merge-safety contract. Pure: no
// Date.now(), Math.random(), or argless `new Date()` (all forbidden in Workflow
// scripts).
//
// THE BUG THIS GUARDS AGAINST
// ship used to merge first (`gh pr merge --squash --admin`) and only check CI
// AFTER the merge, collapsing the result to a single `ci_green` boolean and
// reporting `merged:false` on a PR already on `main` when post-merge CI was red
// (e.g. a concurrency-cancelled run). A squash-merge lands the PR in its own
// step; post-merge CI is only a regression detector that runs AFTER the landing.
// On an active default branch, GitHub Actions `concurrency: cancel-in-progress`
// cancels a commit's CI run the moment a later commit lands — the next merge or
// an unrelated bot PR such as Renovate. A cancelled run is NOT a failure.
// Treating "not green" (which includes cancelled) as a failure falsely reports a
// cleanly-merged PR as unmerged. This module distinguishes a real failing
// conclusion from a concurrency cancellation or a still-pending run, and the new
// mergePrompt gates CI to green BEFORE the merge so post-merge CI is advisory.
//
// `ci` is what the merge subagent reports after inspecting the merge commit's
// checks (and, when that run was cancelled, the default-branch tip's checks):
//   { failing_checks?: string[],  // checks that concluded failure/timed_out/etc.
//     cancelled?: boolean,        // merge-commit run cancelled by a superseding run
//     pending?: boolean }         // checks still running, none failed yet

/**
 * Classify a PR's post-merge default-branch CI from observed check facts.
 *
 *   'failed'     — a check actually concluded failure/timed_out/etc.
 *   'pending'    — checks still running, none failed.
 *   'superseded' — the run was cancelled by a newer commit, none failed.
 *   'green'      — all checks succeeded.
 *
 * Only 'failed' rides along as a post-merge warning. The merge itself has
 * already landed (PR MERGED, branch gone) independent of this classification.
 *
 * @param {{failing_checks?: string[], cancelled?: boolean, pending?: boolean}} [ci]
 * @returns {'failed'|'pending'|'superseded'|'green'}
 */
export function classifyPostMergeCI(ci) {
  const c = ci || {};
  const failing = (c.failing_checks || []).filter(Boolean);
  if (failing.length > 0) return 'failed';
  if (c.pending) return 'pending';
  if (c.cancelled) return 'superseded';
  return 'green';
}

/**
 * Whether post-merge CI proved a real failure on the merged commit. A cancelled
 * or pending run never counts. (For ship this only flags a warning — the PR has
 * already merged — never an un-merge.)
 *
 * @param {{failing_checks?: string[], cancelled?: boolean, pending?: boolean}} [ci]
 * @returns {boolean}
 */
export function postMergeCIStalls(ci) {
  return classifyPostMergeCI(ci) === 'failed';
}

/**
 * The merge-loop decision from the merge subagent's result. The PR lands only
 * when the pre-merge CI gate passed (mergePrompt step 3), so the verdict is:
 *
 *   merged  — the PR landed (`merged: true`). A merged PR is NEVER reported as
 *             not-merged. If post-merge CI flags a genuine regression on the
 *             merge commit, it rides along as `postMergeWarning`; the code is
 *             already on the default branch.
 *   stalled — the PR did NOT land: a pre-merge conflict, a failing blocking
 *             check at the gate, or a gate timeout. `cause` explains which.
 *
 * This replaces the old inline `!!(m.merged && m.ci_green !== false)`, which
 * conflated "merged but post-merge CI flagged" with "did not land", reporting a
 * cleanly-merged PR as merged:false. Pure so it is unit-tested and mirrored.
 *
 * @param {{merged?: boolean, ci?: object, cause?: string|null}} [m]
 * @returns {{state: 'merged'|'stalled', postMergeWarning: string|null, cause: string|null}}
 */
export function mergeVerdict(m) {
  const r = m || {};
  if (r.merged) {
    return {
      state: 'merged',
      postMergeWarning: postMergeCIStalls(r.ci) ? r.cause || 'post-merge CI regression' : null,
      cause: null,
    };
  }
  return {
    state: 'stalled',
    postMergeWarning: null,
    cause: r.cause || 'merge did not land (pre-merge conflict or failing CI gate)',
  };
}
