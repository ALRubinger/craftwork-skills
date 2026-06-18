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

test('escalations: unshipped residuals are excluded (deferral != decision)', () => {
  const results = [
    { residual_issue: 8, sub_issue: 80, shipped: false, findings: [f('DECISION', null)] },
    { residual_issue: 9, sub_issue: 90, shipped: true, findings: [f('DECISION', null)] },
  ];
  const esc = escalations(results);
  assert.equal(esc.length, 1);
  assert.equal(esc[0].residual_issue, 9);
});

test('escalations: carries the recommendation-first question fields', () => {
  const results = [
    {
      residual_issue: 11,
      sub_issue: 100,
      findings: [
        f('DECISION', null, {
          decision_question: 'Repeat the banner each run?',
          recommended_answer: 'Show once per session',
          alt_options: ['Always show', 'Never show'],
        }),
      ],
    },
  ];
  const [e] = escalations(results);
  assert.equal(e.decision_question, 'Repeat the banner each run?');
  assert.equal(e.recommended_answer, 'Show once per session');
  assert.deepEqual(e.alt_options, ['Always show', 'Never show']);
});

test('escalations: question fields default sanely when the planner omits them', () => {
  const [e] = escalations([
    { residual_issue: 3, sub_issue: 30, findings: [f('DECISION', null, { title: 'Pick a name' })] },
  ]);
  assert.equal(e.decision_question, 'Pick a name'); // falls back to the finding title
  assert.equal(e.recommended_answer, null);
  assert.deepEqual(e.alt_options, []);
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
  ];
  assert.deepEqual(parkCandidates(results), [6]);
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
  ];
  assert.deepEqual(deferredResiduals(results), [20, 40]);
});
