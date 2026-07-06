// Regression guard for feedback #8 and the scratch-leak audit. The Resolve stage
// runs park subagents in PARALLEL, and they DON'T get isolation:'worktree' — they
// share the workflow's working directory, which is the operator's PRIMARY checkout.
//
// Two failures had to be designed out:
//   1. Collision: the original parkPrompt fetched every issue body into a FIXED
//      filename `body.md`, so two concurrent parks raced on the same path — A wrote
//      #1206's body, B clobbered it with #1190's, then A pushed #1190's content
//      onto #1206. An interim fix keyed the files per-issue (body-${p.issue}.md).
//   2. Leak: BOTH the shared and the per-issue files were written into the primary
//      checkout and never cleaned up, leaving stray title-N.md / body-N.md behind.
//
// The fix that closes both: each subagent creates a PRIVATE temp dir (mktemp -d)
// and keeps all scratch inside it. A per-agent dir is collision-free (no sibling
// can clobber it) AND leaves the primary checkout pristine. The title/Observation
// match guard that aborts a contaminated write is retained.
//
// parkPrompt is a non-exported template-string builder inside workflow.js, so —
// like mirror.test.mjs — we assert against the extracted source of that builder.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const workflowSrc = readFileSync(join(here, '..', 'workflow.js'), 'utf8');

// Extract the `const parkPrompt = ...` assignment. The builder is one outer
// template literal that NESTS inner template literals inside `${...}`
// interpolations (the umbrella/open-questions ternary), so brace/backtick
// matching is fragile. Instead, slice from this declaration up to the start of
// the next top-level `const NAME =` declaration — a stable, syntax-light anchor
// that captures the whole builder regardless of nested literals.
function extractParkPrompt(src) {
  const start = src.indexOf('const parkPrompt =');
  assert.notEqual(start, -1, 'const parkPrompt not found in workflow.js');
  const next = src.indexOf('\nconst ', start + 1);
  assert.notEqual(next, -1, 'no declaration follows parkPrompt');
  return src.slice(start, next);
}

const parkPromptSrc = extractParkPrompt(workflowSrc);

// Compile the extracted builder into a callable so we can EVALUATE it, not just
// string-match it. The static assertions below never expand the template, so a
// bare `${reason}` interpolation referencing an out-of-scope identifier throws
// only at render time — which is exactly the ReferenceError ("reason is not
// defined") that crashed a real park run. `parkReason` is the one module-scoped
// helper the builder closes over; inject it so the arrow resolves. `JSON` is a
// global and needs nothing.
function compileParkPrompt(src) {
  const arrow = src.replace(/^const parkPrompt =\s*/, '').replace(/;\s*$/, '');
  // eslint-disable-next-line no-new-func
  return new Function('parkReason', `return (${arrow});`)(
    (plan) => (plan && plan.route === 'needs-input' ? 'open-questions' : null),
  );
}

test('parkPrompt RENDERS without throwing — no out-of-scope interpolation', () => {
  // Regression for the `${reason}` crash: parkPrompt referenced an undefined
  // `reason` (the value is `parkReason(p.plan)`), so the whole park pipeline died
  // with "reason is not defined" the moment an issue routed needs-input, leaving
  // it stranded in cw-feedback:triaging with the questions never written back.
  const parkPrompt = compileParkPrompt(parkPromptSrc);
  const a = { repo: 'owner/repo', defaultBranch: 'main' };
  const p = {
    issue: 2014,
    url: 'https://github.com/owner/repo/issues/2014',
    plan: {
      route: 'needs-input',
      claim_comment_id: 12345,
      open_questions: ['Verify by diff_ids or attest the pushed serialization?'],
    },
  };
  let rendered;
  assert.doesNotThrow(() => {
    rendered = parkPrompt(a, p);
  }, 'parkPrompt must render without a ReferenceError for any interpolated identifier');
  // The rendered structured-output line must carry the resolved park reason, not
  // a literal `${reason}` or an empty value.
  assert.match(
    rendered,
    /reason:\s*"open-questions"/,
    'the returned structured-output contract must interpolate the resolved parkReason',
  );
  assert.doesNotMatch(rendered, /\$\{reason\}/, 'no unresolved ${reason} may survive rendering');
});

test('parkPrompt creates a private temp dir for all scratch', () => {
  // mktemp -d gives each concurrent subagent its own directory, so it can use
  // fixed filenames inside it without colliding and without touching the checkout.
  assert.match(
    parkPromptSrc,
    /mktemp -d/,
    'parkPrompt must create a private scratch dir (mktemp -d) so it writes nothing into the primary checkout',
  );
});

test('parkPrompt writes NO scratch into the working checkout — every .md sink is under the temp dir', () => {
  // The leak the audit found: title-N.md / body-N.md written into the operator's
  // primary checkout. Every redirect (`> …`) and every --body-file argument that
  // targets a .md file must live under the private temp dir ($D), never a bare
  // filename in the working directory.
  const sinks = [...parkPromptSrc.matchAll(/(?:>|--body-file)\s+("?\\?\$?[^\s`]*\.md)/g)].map(
    (m) => m[1],
  );
  assert.ok(
    sinks.length >= 3,
    'expected at least the title fetch, body fetch, and --body-file write-back sinks',
  );
  for (const sink of sinks) {
    assert.match(
      sink,
      /\$D\//,
      `scratch sink ${sink} must be under the private temp dir ($D/…), not the primary checkout`,
    );
  }
});

test('the old per-issue / shared filenames are gone from the working dir', () => {
  // Neither the original shared `body.md` nor the interim per-issue body-${p.issue}.md
  // may survive as a bare working-dir path.
  assert.ok(
    !/body-\$\{p\.issue\}\.md/.test(parkPromptSrc),
    'interim per-issue scratch filename body-${p.issue}.md must be replaced by a temp-dir path',
  );
  assert.ok(
    !/title-\$\{p\.issue\}\.md/.test(parkPromptSrc),
    'interim per-issue scratch filename title-${p.issue}.md must be replaced by a temp-dir path',
  );
});

test('parkPrompt adds a title/Observation match guard that aborts a contaminated write', () => {
  // Before pushing, the subagent must verify the fetched body still belongs to
  // THIS issue (title/Observation match) and abort the write if it does not.
  assert.match(
    parkPromptSrc,
    /GUARD/,
    'parkPrompt must include an explicit pre-write GUARD step',
  );
  assert.match(
    parkPromptSrc,
    /\.title/,
    'the guard must re-check the issue title to detect a contaminated read',
  );
  assert.match(
    parkPromptSrc,
    /ABORT|abort/,
    'the guard must abort the write when the read does not match this issue',
  );
  // The guard must key its comparison to THIS issue number, not a generic check.
  assert.match(
    parkPromptSrc,
    /#\$\{p\.issue\}/,
    'the guard must compare against this issue (#${p.issue})',
  );
});
