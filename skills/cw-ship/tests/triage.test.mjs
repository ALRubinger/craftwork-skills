import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dispositionFor, parkReason, actionQueues, escalations } from '../triage.mjs';

const fix = (qs = []) => ({ route: 'fix', summary: 's', open_questions: qs });
const needs = (qs = ['q?']) => ({ route: 'needs-input', summary: 's', open_questions: qs });
const umbrella = () => ({ route: 'umbrella', summary: 's', umbrella_scope: { title: 't', why: 'w', sub_issues: [] } });

test('fix with no open questions -> build', () => {
  assert.equal(dispositionFor(fix([])), 'build');
});

test('fix WITH open questions -> park (planner surfaced a late fork)', () => {
  assert.equal(dispositionFor(fix(['which X?'])), 'park');
});

test('needs-input always parks', () => {
  assert.equal(dispositionFor(needs()), 'park');
});

// The go gate is GONE for umbrellas: an umbrella-sized plan with clear intent
// (route "umbrella") files directly whether or not the issue carried cw-feedback:go.
// A genuine fork is expressed as route "needs-input" (which parks), never as an
// un-cleared umbrella — being umbrella-sized is no longer itself a reason to park.
test('umbrella always files — no go gate', () => {
  assert.equal(dispositionFor(umbrella()), 'umbrella');
});

test('missing/empty plan defensively parks', () => {
  assert.equal(dispositionFor(null), 'park');
  assert.equal(dispositionFor({}), 'park');
});

test('parkReason is open-questions when parked, null otherwise (umbrella-scope retired)', () => {
  assert.equal(parkReason(needs()), 'open-questions');
  assert.equal(parkReason(fix(['q?'])), 'open-questions');
  assert.equal(parkReason(fix([])), null); // build — not parked
  assert.equal(parkReason(umbrella()), null); // umbrella files — not parked
});

test('actionQueues partitions and preserves discovery order', () => {
  const planned = [
    { issue: 5, url: 'u5', plan: fix([]) }, // build
    { issue: 3, url: 'u3', plan: needs() }, // park
    { issue: 9, url: 'u9', plan: umbrella() }, // umbrella (no go needed)
    { issue: 1, url: 'u1', plan: umbrella() }, // umbrella (no go needed)
    { issue: 7, url: 'u7', plan: fix([]) }, // build
  ];
  const q = actionQueues(planned);
  assert.deepEqual(q.build.map((p) => p.issue), [5, 7]);
  assert.deepEqual(q.umbrella.map((p) => p.issue), [9, 1]);
  assert.deepEqual(q.park.map((p) => p.issue), [3]);
});

test('actionQueues tolerates nulls from skipped agents', () => {
  const q = actionQueues([null, { issue: 2, url: 'u2', plan: fix([]) }, null]);
  assert.deepEqual(q.build.map((p) => p.issue), [2]);
});

test('escalations lists only parked issues, sorted, with reason + questions', () => {
  const planned = [
    { issue: 9, url: 'u9', plan: needs(['a?', 'b?']) }, // parked — genuine fork
    { issue: 4, url: 'u4', plan: fix([]) }, // build, not escalated
    { issue: 2, url: 'u2', plan: umbrella() }, // umbrella files — NOT escalated anymore
  ];
  const e = escalations(planned);
  assert.deepEqual(e.map((x) => x.issue), [9]);
  assert.equal(e[0].reason, 'open-questions');
  assert.deepEqual(e[0].questions, ['a?', 'b?']);
});

test('escalations empty when everything is actionable', () => {
  const planned = [
    { issue: 1, url: 'u1', plan: fix([]) },
    { issue: 2, url: 'u2', plan: umbrella() },
  ];
  assert.deepEqual(escalations(planned), []);
});
