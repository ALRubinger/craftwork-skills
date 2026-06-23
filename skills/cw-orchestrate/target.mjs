// Canonical, pure, unit-tested merge-target derivation for cw-orchestrate.
//
// Unlike scheduler.mjs / triage.mjs / merge-ci.mjs, this module is **NOT**
// inlined into workflow.js and so has **no** entry in mirror.test.mjs. It is a
// MAIN-SESSION helper: the background Workflow never reads the umbrella's
// labels — reading the `cw-target:<slug>` label and deriving the target branch
// is pre-"go" work the interactive sweep does (SKILL.md Step 1/Step 4). The
// Workflow only consumes the resulting `targetBranch` field once it is already
// in the manifest. Adding this module to mirror.test.mjs would fail (no
// counterpart in workflow.js); keeping it here, called from the SKILL.md
// recipe, keeps the no-duplicated-state rule intact: this is the single
// derivation of slug -> branch.
//
// The `cw-target:<slug>` label on the umbrella is the SINGLE SOURCE OF TRUTH
// for the merge target (see cw-scope's issue-templates.md). The slug is the
// suffix of both the label and the branch `integration/<slug>`, and is already
// produced git-ref-safe by cw-scope (lowercase, hyphen-separated, no spaces or
// slashes). This helper does NOT normalize or "fix" a bad slug — it only
// rejects the empty/whitespace mistake; everything else is taken as-is.
//
// Pure: no Date.now(), no Math.random(), no argless `new Date()`.

const PREFIX = 'cw-target:';

/**
 * The integration branch name for a slug. Single derivation shared by the
 * helper and any caller (SKILL.md, tests) so the slug -> branch mapping is
 * defined in exactly one place.
 * @param {string} slug
 * @returns {string}
 */
export function integrationBranchFor(slug) {
  return `integration/${slug}`;
}

/**
 * Derive the run's merge target from the umbrella's labels.
 *
 *   0 `cw-target:*` labels ⇒ { targetBranch: null, slug: null }
 *       The caller OMITS `targetBranch` from the manifest; the Workflow then
 *       defaults the merge target to `defaultBranch` (behavior unchanged).
 *   1 `cw-target:*` label  ⇒ { targetBranch: 'integration/<slug>', slug }
 *   >1 `cw-target:*` label ⇒ throws (operator removes the extra label).
 *
 * An empty / whitespace-only slug is a hard stop (throws) — never a silent
 * fall-back to `defaultBranch` — so a malformed label can never quietly
 * retarget (or fail to retarget) a run.
 *
 * @param {string[]} labels label names, e.g. from
 *   `gh issue view <umbrella> --json labels --jq '.labels[].name'`
 * @returns {{ targetBranch: string|null, slug: string|null }}
 * @throws {Error} on multiple `cw-target:*` labels or an empty/whitespace slug
 */
export function deriveTarget(labels) {
  const matches = (labels || []).filter(
    (name) => typeof name === 'string' && name.startsWith(PREFIX),
  );

  if (matches.length === 0) return { targetBranch: null, slug: null };

  if (matches.length > 1) {
    throw new Error(
      `umbrella carries multiple cw-target:* labels (${matches.join(', ')}); ` +
        'remove all but one before orchestrating',
    );
  }

  const slug = matches[0].slice(PREFIX.length);
  if (slug.trim() === '') {
    throw new Error(
      'cw-target label has an empty slug; the slug must be a git-ref-safe segment',
    );
  }

  return { targetBranch: integrationBranchFor(slug), slug };
}
