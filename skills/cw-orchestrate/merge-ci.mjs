// Canonical, pure, unit-tested post-merge CI classification.
//
// `workflow.js` inlines a byte-for-byte mirror of this function because a Claude
// Code Workflow script (a) auto-runs its body on evaluation and (b) has no
// filesystem/module access at runtime, so it can neither be imported by a Node
// test nor import this module. This file is the tested source of truth; keep the
// mirror in workflow.js in sync (mirror.test.mjs enforces it). Pure: no
// Date.now(), Math.random(), or argless `new Date()` (all forbidden in Workflow
// scripts).
//
// THE BUG THIS GUARDS AGAINST
// A serialized squash-merge lands the PR in its own step; post-merge CI is only a
// regression detector that runs AFTER the landing. On an active default branch,
// GitHub Actions `concurrency: cancel-in-progress` cancels a commit's CI run the
// moment a later commit lands — the next serialized node, or an unrelated bot PR
// such as Renovate. A cancelled run is NOT a failure. Treating "not green" (which
// includes cancelled) as a failure falsely stalls a cleanly-merged node and
// cascade-halts its dependents. This function distinguishes a real failing
// conclusion from a concurrency cancellation or a still-pending run.
//
// `ci` is what the merge subagent reports after inspecting the merge commit's
// checks (and, when that run was cancelled, the default-branch tip's checks):
//   { failing_checks?: string[],  // checks that concluded failure/timed_out/etc.
//     cancelled?: boolean,        // merge-commit run cancelled by a superseding run
//     pending?: boolean }         // checks still running, none failed yet

/**
 * Classify a node's post-merge default-branch CI from observed check facts.
 *
 *   'failed'     — a check actually concluded failure/timed_out/etc.; stall the node.
 *   'pending'    — checks still running, none failed; do NOT stall.
 *   'superseded' — the run was cancelled by a newer commit, none failed; do NOT stall.
 *   'green'      — all checks succeeded.
 *
 * Only 'failed' should block the merge verdict. The merge itself has already
 * landed (PR MERGED, branch gone) independent of this classification.
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
 * The single gate the merge loop uses: should this node stall on post-merge CI?
 * True only when CI proved a real failure. A cancelled or pending run never stalls.
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
 *   merged  — the PR landed (`merged: true`). A merged node is NEVER relabeled
 *             stalled. If post-merge CI flags a genuine regression on the merge
 *             commit, it rides along as `postMergeWarning` and does NOT halt
 *             dependents (the code is already on the default branch).
 *   stalled — the PR did NOT land: a pre-merge conflict, a failing blocking
 *             check at the gate, or a gate timeout. `cause` explains which.
 *
 * This was previously inline in workflow.js and conflated "merged but
 * post-merge CI flagged" with "did not land", mislabeling a cleanly-merged node
 * as stalled. Pure so it is unit-tested and mirrored.
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
