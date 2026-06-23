import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  closeDisposition,
  highConfidenceFixes,
  autofixCandidates,
  escalations,
  parkCandidates,
  deferredResiduals,
} from '../triage.mjs';

const f = (verdict, confidence, extra = {}) => ({
  title: `${verdict}/${confidence || '-'}`,
  verdict,
  confidence,
  ...extra,
});

test('closeDisposition: no findings -> close-now', () => {
  assert.equal(closeDisposition({ findings: [] }), 'close-now');
  assert.equal(closeDisposition({}), 'close-now');
});

test('closeDisposition: all RESOLVED/MOOT -> close-now', () => {
  assert.equal(
    closeDisposition({ findings: [f('RESOLVED'), f('MOOT'), f('RESOLVED')] }),
    'close-now',
  );
});

test('closeDisposition: RESOLVED/MOOT + only high-conf FIX_NOW -> close-via-autofix', () => {
  assert.equal(
    closeDisposition({ findings: [f('RESOLVED'), f('FIX_NOW', 'high'), f('MOOT')] }),
    'close-via-autofix',
  );
});

test('closeDisposition: any DECISION -> keep-open', () => {
  assert.equal(
    closeDisposition({ findings: [f('FIX_NOW', 'high'), f('DECISION', null)] }),
    'keep-open',
  );
});

test('closeDisposition: low-confidence FIX_NOW forces keep-open (never silently auto-fixed)', () => {
  assert.equal(
    closeDisposition({ findings: [f('RESOLVED'), f('FIX_NOW', 'low')] }),
    'keep-open',
  );
});

test('highConfidenceFixes: only high-confidence FIX_NOW pass the gate', () => {
  const result = {
    findings: [f('FIX_NOW', 'high'), f('FIX_NOW', 'low'), f('DECISION', null), f('RESOLVED')],
  };
  const fixes = highConfidenceFixes(result);
  assert.equal(fixes.length, 1);
  assert.equal(fixes[0].confidence, 'high');
  assert.equal(fixes[0].verdict, 'FIX_NOW');
});

test('autofixCandidates: only residuals with >=1 high-conf FIX_NOW, ascending', () => {
  const results = [
    { residual_issue: 30, findings: [f('FIX_NOW', 'low')] }, // low conf -> excluded
    { residual_issue: 10, findings: [f('FIX_NOW', 'high')] },
    { residual_issue: 20, findings: [f('RESOLVED'), f('MOOT')] }, // nothing -> excluded
    { residual_issue: 5, findings: [f('DECISION', null), f('FIX_NOW', 'high')] },
  ];
  assert.deepEqual(autofixCandidates(results), [5, 10]);
});

test('autofixCandidates: tolerates null/empty', () => {
  assert.deepEqual(autofixCandidates([]), []);
  assert.deepEqual(autofixCandidates([null]), []);
  assert.deepEqual(autofixCandidates(undefined), []);
});

test('escalations: DECISION and low-conf FIX_NOW surface; RESOLVED/MOOT/high-conf do not', () => {
  const results = [
    {
      residual_issue: 12,
      sub_issue: 100,
      findings: [f('DECISION', null, { severity: 'P1', rationale: 'judgment' }), f('RESOLVED')],
    },
    {
      residual_issue: 7,
      sub_issue: 99,
      findings: [f('FIX_NOW', 'low', { severity: 'P2' }), f('FIX_NOW', 'high')],
    },
  ];
  const esc = escalations(results);
  assert.equal(esc.length, 2);
  // residual-ascending
  assert.equal(esc[0].residual_issue, 7);
  assert.equal(esc[0].verdict, 'FIX_NOW');
  assert.equal(esc[0].confidence, 'low');
  assert.equal(esc[1].residual_issue, 12);
  assert.equal(esc[1].verdict, 'DECISION');
});

test('parkCandidates: shipped residuals with judgment calls, ascending', () => {
  const results = [
    { residual_issue: 30, shipped: true, findings: [f('FIX_NOW', 'low')] }, // low-conf -> human
    { residual_issue: 10, shipped: true, findings: [f('DECISION', null), f('FIX_NOW', 'high')] },
    { residual_issue: 20, shipped: true, findings: [f('RESOLVED'), f('FIX_NOW', 'high')] }, // no human
  ];
  assert.deepEqual(parkCandidates(results), [10, 30]);
});

test('parkCandidates: excludes unshipped residuals (they defer, not park)', () => {
  const results = [
    { residual_issue: 5, shipped: false, findings: [f('DECISION', null)] },
    { residual_issue: 6, shipped: true, findings: [f('DECISION', null)] },
    { residual_issue: 7, findings: [f('DECISION', null)] }, // shipped undefined -> park (not deferred)
  ];
  assert.deepEqual(parkCandidates(results), [6, 7]);
});

test('parkCandidates: tolerates null/empty', () => {
  assert.deepEqual(parkCandidates([]), []);
  assert.deepEqual(parkCandidates([null]), []);
  assert.deepEqual(parkCandidates(undefined), []);
});

test('deferredResiduals: only unshipped sub-issues, ascending', () => {
  const results = [
    { residual_issue: 40, shipped: false },
    { residual_issue: 10, shipped: true },
    { residual_issue: 20, shipped: false },
    { residual_issue: 30 }, // shipped undefined -> treated as shipped (not deferred)
  ];
  assert.deepEqual(deferredResiduals(results), [20, 40]);
});
