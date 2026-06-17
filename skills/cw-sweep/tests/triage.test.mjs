import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  closeDisposition,
  highConfidenceFixes,
  autofixCandidates,
  escalations,
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
  assert.equal(closeDisposition({ findings: [f('RESOLVED'), f('MOOT')] }), 'close-now');
});

test('closeDisposition: RESOLVED/MOOT + only high-conf FIX_NOW -> close-via-autofix', () => {
  assert.equal(
    closeDisposition({ findings: [f('RESOLVED'), f('FIX_NOW', 'high')] }),
    'close-via-autofix',
  );
});

test('closeDisposition: DECISION or low-conf FIX_NOW -> keep-open', () => {
  assert.equal(closeDisposition({ findings: [f('FIX_NOW', 'high'), f('DECISION', null)] }), 'keep-open');
  assert.equal(closeDisposition({ findings: [f('RESOLVED'), f('FIX_NOW', 'low')] }), 'keep-open');
});

test('highConfidenceFixes: only high-confidence FIX_NOW pass the gate', () => {
  const fixes = highConfidenceFixes({
    findings: [f('FIX_NOW', 'high'), f('FIX_NOW', 'low'), f('DECISION', null)],
  });
  assert.equal(fixes.length, 1);
  assert.equal(fixes[0].confidence, 'high');
});

test('autofixCandidates: only residuals with >=1 high-conf FIX_NOW, ascending', () => {
  const results = [
    { residual_issue: 30, findings: [f('FIX_NOW', 'low')] },
    { residual_issue: 10, findings: [f('FIX_NOW', 'high')] },
    { residual_issue: 20, findings: [f('RESOLVED')] },
    { residual_issue: 5, findings: [f('DECISION', null), f('FIX_NOW', 'high')] },
  ];
  assert.deepEqual(autofixCandidates(results), [5, 10]);
});

test('autofixCandidates: tolerates null/empty', () => {
  assert.deepEqual(autofixCandidates([]), []);
  assert.deepEqual(autofixCandidates([null]), []);
  assert.deepEqual(autofixCandidates(undefined), []);
});

test('escalations: DECISION and low-conf FIX_NOW surface, residual-ascending', () => {
  const results = [
    { residual_issue: 12, sub_issue: 100, findings: [f('DECISION', null), f('RESOLVED')] },
    { residual_issue: 7, sub_issue: 99, findings: [f('FIX_NOW', 'low'), f('FIX_NOW', 'high')] },
  ];
  const esc = escalations(results);
  assert.equal(esc.length, 2);
  assert.equal(esc[0].residual_issue, 7);
  assert.equal(esc[1].residual_issue, 12);
});

test('deferredResiduals: only unshipped sub-issues, ascending', () => {
  const results = [
    { residual_issue: 40, shipped: false },
    { residual_issue: 10, shipped: true },
    { residual_issue: 20, shipped: false },
  ];
  assert.deepEqual(deferredResiduals(results), [20, 40]);
});
