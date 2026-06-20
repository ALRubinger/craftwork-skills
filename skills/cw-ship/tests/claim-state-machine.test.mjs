// Regression guard for feedback #15: cw-ship left an issue carrying BOTH
// cw-feedback:triaging (the in-flight claim) AND cw-feedback:needs-input (a terminal
// state), and a run scoped to a live-claimed issue returned a bare empty result
// indistinguishable from "nothing to do" — which tricked a manual claim reset.
//
// Three coupled fixes, all enforced here against the SOURCE of workflow.js's
// prompt builders (they are non-exported template-string builders, so — like
// mirror.test.mjs and park-prompt.test.mjs — we assert on the extracted source):
//   1. Claim-vs-terminal label invariant: the claim step removes the terminal
//      label cw-feedback:needs-input when it adds cw-feedback:triaging, and the merge
//      step removes cw-feedback:triaging as the issue closes.
//   2. First-class claimed_elsewhere outcome: discovery surfaces live-claimed
//      issues in a distinct field carried through DISCOVER_SCHEMA and the report.
//   3. Safe stranded-claim recovery: the surfaced outcome carries reclaim_at, so
//      the operator waits for the auto-reclaim instead of resetting the label.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const workflowSrc = readFileSync(join(here, '..', 'workflow.js'), 'utf8');

// Slice a `const NAME = ...` builder up to the next top-level `const NAME =`
// declaration — the stable, nesting-tolerant anchor park-prompt.test.mjs uses.
function extractConst(src, name) {
  const start = src.indexOf(`const ${name} =`);
  assert.notEqual(start, -1, `const ${name} not found in workflow.js`);
  const next = src.indexOf('\nconst ', start + 1);
  assert.notEqual(next, -1, `no declaration follows ${name}`);
  return src.slice(start, next);
}

// --- (1) Claim-vs-terminal label invariant ------------------------------------

test('claim step removes cw-feedback:needs-input when it adds cw-feedback:triaging', () => {
  // Re-claiming an issue that still carries the parked terminal label must clear
  // it, or the issue is left carrying both the claim label and a terminal label.
  const planSrc = extractConst(workflowSrc, 'planPrompt');
  const claimEdit = planSrc.match(/gh issue edit[^`]*--add-label cw-feedback:triaging[^`]*/);
  assert.ok(claimEdit, 'planPrompt must add cw-feedback:triaging via gh issue edit');
  assert.match(
    claimEdit[0],
    /--remove-label cw-feedback:needs-input/,
    'the claim edit must also remove cw-feedback:needs-input (claim label and terminal label are mutually exclusive)',
  );
  // The pre-existing entry-label removals must remain.
  assert.match(claimEdit[0], /--remove-label cw-feedback:new/);
  assert.match(claimEdit[0], /--remove-label cw-feedback:go/);
});

test('merge step removes cw-feedback:triaging as the issue closes', () => {
  // A merged/closed feedback issue must not keep the in-flight claim label.
  const mergeSrc = extractConst(workflowSrc, 'mergePrompt');
  assert.match(
    mergeSrc,
    /gh issue edit[^`]*--remove-label cw-feedback:triaging/,
    'mergePrompt must remove cw-feedback:triaging in the terminal (close) transition',
  );
});

// --- (2) First-class claimed_elsewhere outcome --------------------------------

test('DISCOVER_SCHEMA carries a claimed_elsewhere array with the field shape', () => {
  const schemaSrc = extractConst(workflowSrc, 'DISCOVER_SCHEMA');
  assert.match(schemaSrc, /claimed_elsewhere\s*:/, 'DISCOVER_SCHEMA must declare claimed_elsewhere');
  for (const field of ['issue', 'url', 'last_activity', 'claim_age', 'reclaim_at']) {
    assert.match(
      schemaSrc,
      new RegExp(`required:[^\\]]*'${field}'`),
      `claimed_elsewhere items must require ${field}`,
    );
  }
});

test('discoverPrompt instructs surfacing live-claimed issues into claimed_elsewhere', () => {
  const discoverSrc = extractConst(workflowSrc, 'discoverPrompt');
  assert.match(discoverSrc, /claimed_elsewhere/, 'discoverPrompt must name the claimed_elsewhere outcome');
  assert.match(
    discoverSrc,
    /reclaim_at/,
    'discoverPrompt must instruct computing reclaim_at for a live-claimed issue',
  );
  // It must NOT silently drop live-claimed issues anymore.
  assert.doesNotMatch(
    discoverSrc,
    /EXCLUDE it: another run owns it right now/,
    'discoverPrompt must no longer silently EXCLUDE live-claimed issues — they go to claimed_elsewhere',
  );
});

test('the Workflow report includes claimed_elsewhere on both return paths', () => {
  // The empty-backlog early return and the final report must both carry it, so an
  // --only run on a live-claimed target never returns a bare empty result.
  const returns = workflowSrc.match(/claimed_elsewhere/g) || [];
  // schema decl + comment(s) + early-return + report + log; assert the two return
  // sites specifically.
  assert.match(
    workflowSrc,
    /return \{ repo: cfg\.repo, planned: \[\][^}]*claimed_elsewhere[^}]*\};/,
    'the empty-backlog early return must include claimed_elsewhere',
  );
  assert.match(
    workflowSrc,
    /const report = \{[\s\S]*claimed_elsewhere,[\s\S]*\};/,
    'the final report object must include claimed_elsewhere',
  );
  assert.ok(returns.length >= 4, 'claimed_elsewhere should be wired through schema, discover, and both returns');
});

// --- (3) The contract doc documents the invariant + safe-recovery rule --------

test('state-machine.md documents the claim-vs-terminal label invariant', () => {
  const doc = readFileSync(join(here, '..', 'references', 'state-machine.md'), 'utf8');
  assert.match(doc, /mutually exclusive/i, 'doc must state the claim/terminal labels are mutually exclusive');
  assert.match(doc, /cw-feedback:triaging/, 'doc must name the claim label');
  assert.match(doc, /cw-feedback:needs-input/, 'doc must name the terminal label');
});

test('state-machine.md documents safe stranded-claim recovery (wait for auto-reclaim, not a manual reset)', () => {
  const doc = readFileSync(join(here, '..', 'references', 'state-machine.md'), 'utf8');
  assert.match(doc, /claimed_elsewhere/, 'doc must describe the claimed_elsewhere outcome');
  assert.match(doc, /reclaim_at|auto-reclaim/i, 'doc must describe the auto-reclaim instant');
  // It must steer away from the manual triaging->new reset that races a live run.
  assert.match(
    doc,
    /do \*\*not\*\* manually reset|do not manually reset|not.*manual.*reset/i,
    'doc must warn against the manual triaging->new reset',
  );
});
