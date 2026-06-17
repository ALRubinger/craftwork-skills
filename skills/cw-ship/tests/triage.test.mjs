import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dispositionFor, parkReason, actionQueues, escalations } from '../triage.mjs';

const fix = (qs = []) => ({ route: 'fix', summary: 's', open_questions: qs });
const needs = (qs = ['q?']) => ({ route: 'needs-input', summary: 's', open_questions: qs });
const umbrella = () => ({ route: 'umbrella', summary: 's', umbrella_scope: { title: 't', why: 'w', sub_issues: [] } });

test('fix with no open questions -> build', () => {
  assert.equal(dispositionFor(fix([]), false), 'build');
  assert.equal(dispositionFor(fix([]), true), 'build');
});

test('fix WITH open questions -> park (planner surfaced a late fork)', () => {
  assert.equal(dispositionFor(fix(['which X?']), false), 'park');
});

test('needs-input always parks, go or not', () => {
  assert.equal(dispositionFor(needs(), false), 'park');
  assert.equal(dispositionFor(needs(), true), 'park');
});

test('umbrella parks until cleared, then routes to umbrella', () => {
  assert.equal(dispositionFor(umbrella(), false), 'park');
  assert.equal(dispositionFor(umbrella(), true), 'umbrella');
});

test('missing/empty plan defensively parks', () => {
  assert.equal(dispositionFor(null, true), 'park');
  assert.equal(dispositionFor({}, true), 'park');
});

test('parkReason distinguishes umbrella-scope from open-questions', () => {
  assert.equal(parkReason(umbrella(), false), 'umbrella-scope');
  assert.equal(parkReason(needs(), false), 'open-questions');
  assert.equal(parkReason(fix(['q?']), false), 'open-questions');
  assert.equal(parkReason(fix([]), false), null); // not parked
});

test('actionQueues partitions and preserves discovery order', () => {
  const planned = [
    { issue: 5, url: 'u5', hasGo: false, plan: fix([]) }, // build
    { issue: 3, url: 'u3', hasGo: false, plan: needs() }, // park
    { issue: 9, url: 'u9', hasGo: true, plan: umbrella() }, // umbrella
    { issue: 1, url: 'u1', hasGo: false, plan: umbrella() }, // park (not cleared)
    { issue: 7, url: 'u7', hasGo: true, plan: fix([]) }, // build
  ];
  const q = actionQueues(planned);
  assert.deepEqual(q.build.map((p) => p.issue), [5, 7]);
  assert.deepEqual(q.umbrella.map((p) => p.issue), [9]);
  assert.deepEqual(q.park.map((p) => p.issue), [3, 1]);
});

test('actionQueues tolerates nulls from skipped agents', () => {
  const q = actionQueues([null, { issue: 2, url: 'u2', hasGo: false, plan: fix([]) }, null]);
  assert.deepEqual(q.build.map((p) => p.issue), [2]);
});

test('escalations lists only parked issues, sorted, with reason + questions', () => {
  const planned = [
    { issue: 9, url: 'u9', hasGo: false, plan: needs(['a?', 'b?']) },
    { issue: 4, url: 'u4', hasGo: false, plan: fix([]) }, // build, not escalated
    { issue: 2, url: 'u2', hasGo: false, plan: umbrella() }, // parked umbrella-scope
  ];
  const e = escalations(planned);
  assert.deepEqual(e.map((x) => x.issue), [2, 9]);
  assert.equal(e[0].reason, 'umbrella-scope');
  assert.equal(e[1].reason, 'open-questions');
  assert.deepEqual(e[1].questions, ['a?', 'b?']);
});

test('escalations empty when everything is actionable', () => {
  const planned = [
    { issue: 1, url: 'u1', hasGo: true, plan: fix([]) },
    { issue: 2, url: 'u2', hasGo: true, plan: umbrella() },
  ];
  assert.deepEqual(escalations(planned), []);
});
