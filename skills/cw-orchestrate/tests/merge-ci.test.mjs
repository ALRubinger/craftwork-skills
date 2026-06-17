import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyPostMergeCI, postMergeCIStalls, mergeVerdict } from '../merge-ci.mjs';

test('all checks succeeded → green, does not stall', () => {
  assert.equal(classifyPostMergeCI({ failing_checks: [], cancelled: false, pending: false }), 'green');
  assert.equal(postMergeCIStalls({ failing_checks: [], cancelled: false, pending: false }), false);
});

test('a real failing check → failed, stalls', () => {
  const ci = { failing_checks: ['Unit Tests (sandbox)'], cancelled: false, pending: false };
  assert.equal(classifyPostMergeCI(ci), 'failed');
  assert.equal(postMergeCIStalls(ci), true);
});

// The regression this whole module exists for: a cleanly-merged node whose
// post-merge CI was cancelled by GitHub Actions concurrency (a later commit —
// the next serialized node or a Renovate PR — landed on the default branch)
// must NOT be treated as a failure. Before the fix this read as "not green" and
// falsely stalled the node, cascade-halting its dependents.
test('cancelled by superseding run, no failures → superseded, does NOT stall', () => {
  const ci = { failing_checks: [], cancelled: true, pending: false };
  assert.equal(classifyPostMergeCI(ci), 'superseded');
  assert.equal(postMergeCIStalls(ci), false);
});

test('checks still running, none failed → pending, does NOT stall', () => {
  const ci = { failing_checks: [], cancelled: false, pending: true };
  assert.equal(classifyPostMergeCI(ci), 'pending');
  assert.equal(postMergeCIStalls(ci), false);
});

test('a real failure alongside a cancellation still counts as failed', () => {
  const ci = { failing_checks: ['Integration Tests (Go)'], cancelled: true, pending: true };
  assert.equal(classifyPostMergeCI(ci), 'failed');
  assert.equal(postMergeCIStalls(ci), true);
});

test('failing_checks takes precedence over pending', () => {
  assert.equal(classifyPostMergeCI({ failing_checks: ['Lint'], pending: true }), 'failed');
});

test('empty / undefined / null ci → green (no observed failure, do not stall)', () => {
  assert.equal(classifyPostMergeCI(undefined), 'green');
  assert.equal(classifyPostMergeCI(null), 'green');
  assert.equal(classifyPostMergeCI({}), 'green');
  assert.equal(postMergeCIStalls(undefined), false);
});

test('falsy entries in failing_checks are ignored', () => {
  assert.equal(classifyPostMergeCI({ failing_checks: ['', null] }), 'green');
  assert.equal(classifyPostMergeCI({ failing_checks: ['', 'real-failure'] }), 'failed');
});

// mergeVerdict: the merge-loop decision. The bug this guards against — a
// cleanly-merged PR whose post-merge CI flagged something (or whose run was
// cancelled) was relabeled "stalled", implying it never landed.
test('merged with clean post-merge CI → merged, no warning', () => {
  const v = mergeVerdict({ merged: true, ci: { failing_checks: [] } });
  assert.equal(v.state, 'merged');
  assert.equal(v.postMergeWarning, null);
  assert.equal(v.cause, null);
});

test('merged but post-merge CI flagged a real failure → still merged, with warning (NOT stalled)', () => {
  const v = mergeVerdict({ merged: true, ci: { failing_checks: ['Integration Tests (Go)'] }, cause: 'flaky x' });
  assert.equal(v.state, 'merged');
  assert.equal(v.postMergeWarning, 'flaky x');
});

test('merged but post-merge run cancelled by a superseding commit → merged, no warning', () => {
  const v = mergeVerdict({ merged: true, ci: { failing_checks: [], cancelled: true } });
  assert.equal(v.state, 'merged');
  assert.equal(v.postMergeWarning, null);
});

test('did not land (failing pre-merge gate) → stalled with cause', () => {
  const v = mergeVerdict({ merged: false, cause: 'pre-merge CI failed: Unit Tests (rest)' });
  assert.equal(v.state, 'stalled');
  assert.equal(v.cause, 'pre-merge CI failed: Unit Tests (rest)');
  assert.equal(v.postMergeWarning, null);
});

test('did not land with no cause → stalled with default cause', () => {
  const v = mergeVerdict({ merged: false });
  assert.equal(v.state, 'stalled');
  assert.match(v.cause, /did not land/);
});

test('merged flag wins even with a default cause present', () => {
  const v = mergeVerdict({ merged: true, ci: {}, cause: 'ignored when merged & clean' });
  assert.equal(v.state, 'merged');
  assert.equal(v.postMergeWarning, null);
});
