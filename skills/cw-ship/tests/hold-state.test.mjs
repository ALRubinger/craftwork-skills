// Regression guard for feedback #25: cw-feedback:hold — feedback cataloged in the
// backlog but excluded from cw-ship discovery until an operator releases it.
//
// Hold is a mutually-exclusive STATE label. Discovery's entry-state queries list
// only :new and :go, so a held issue is invisible by construction — no extra
// filter. The one place it surfaces is an --only run scoped directly at a held
// issue: discovery returns it in a first-class `held` array so the run reports
// "on hold, skipped" instead of a bare empty result. These tests assert that
// wiring against the SOURCE of workflow.js (its prompt/schema builders are
// non-exported template strings, so we assert on extracted source — the same
// pattern as claim-state-machine.test.mjs) and the doc set.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const workflowSrc = readFileSync(join(here, '..', 'workflow.js'), 'utf8');

function extractConst(src, name) {
  const start = src.indexOf(`const ${name} =`);
  assert.notEqual(start, -1, `const ${name} not found in workflow.js`);
  const next = src.indexOf('\nconst ', start + 1);
  assert.notEqual(next, -1, `no declaration follows ${name}`);
  return src.slice(start, next);
}

// --- (1) DISCOVER_SCHEMA carries a held array ---------------------------------

test('DISCOVER_SCHEMA declares a held array requiring issue + url', () => {
  const schemaSrc = extractConst(workflowSrc, 'DISCOVER_SCHEMA');
  assert.match(schemaSrc, /held\s*:/, 'DISCOVER_SCHEMA must declare held');
  for (const field of ['issue', 'url']) {
    assert.match(
      schemaSrc,
      new RegExp(`required:[^\\]]*'${field}'`),
      `held items must require ${field}`,
    );
  }
});

// --- (2) discoverPrompt excludes held issues and surfaces --only targets ------

test('discoverPrompt names cw-feedback:hold and routes it to the held outcome', () => {
  const discoverSrc = extractConst(workflowSrc, 'discoverPrompt');
  assert.match(discoverSrc, /cw-feedback:hold/, 'discoverPrompt must name the hold label');
  assert.match(discoverSrc, /\bheld\b/, 'discoverPrompt must name the held outcome');
  // A held issue must never be built — it must not go into `issues`.
  assert.match(
    discoverSrc,
    /NEVER put a cw-feedback:hold issue in/,
    'discoverPrompt must forbid putting a held issue in the buildable `issues` set',
  );
});

test('discoverPrompt entry-state queries never list cw-feedback:hold', () => {
  const discoverSrc = extractConst(workflowSrc, 'discoverPrompt');
  // The entry-state list queries must only ever filter on :new and :go, so a held
  // issue is invisible to an unscoped run by construction.
  const listLines = discoverSrc
    .split('\n')
    .filter((l) => l.includes('gh issue list') && l.includes('--label cw-feedback'));
  assert.ok(listLines.length >= 2, 'discoverPrompt should issue the entry-state list queries');
  for (const line of listLines) {
    assert.doesNotMatch(
      line,
      /--label cw-feedback:hold/,
      'no discovery list query may filter on cw-feedback:hold — held issues are excluded by construction',
    );
  }
});

// --- (3) held is wired through both return paths ------------------------------

test('the Workflow report includes held on both return paths', () => {
  assert.match(
    workflowSrc,
    /return \{ repo: cfg\.repo, planned: \[\][^}]*\bheld\b[^}]*\};/,
    'the empty-backlog early return must include held',
  );
  assert.match(
    workflowSrc,
    /const report = \{[\s\S]*\bheld,[\s\S]*\};/,
    'the final report object must include held',
  );
});

// --- (4) docs document the hold state -----------------------------------------

test('state-machine.md documents the hold state, its mutual exclusivity, and discovery exclusion', () => {
  const doc = readFileSync(join(here, '..', 'references', 'state-machine.md'), 'utf8');
  assert.match(doc, /cw-feedback:hold/, 'doc must name the hold label');
  assert.match(doc, /mutually exclusive/i, 'doc must state hold is mutually exclusive with other state labels');
  assert.match(doc, /excluded from discovery|never lists/i, 'doc must state discovery excludes held issues');
  // Release is an operator hand-swap, NOT cw-resolve.
  assert.match(doc, /hold.*->.*new|:hold.*:new/i, 'doc must describe the :hold -> :new release swap');
  assert.match(doc, /not.*released through.*cw-resolve|not.*cw-resolve/i, 'doc must state holds are not released via cw-resolve');
});

test('cw-feedback SKILL documents filing/marking on hold and the create-label step', () => {
  const skill = readFileSync(join(here, '..', '..', 'cw-feedback', 'SKILL.md'), 'utf8');
  assert.match(skill, /gh label create cw-feedback:hold/, 'SKILL must ensure the hold label exists');
  assert.match(skill, /--label cw-feedback:hold/, 'SKILL must show filing directly in the held state');
  assert.match(skill, /--add-label cw-feedback:hold --remove-label cw-feedback:new/, 'SKILL must show flag-after-the-fact');
  assert.match(skill, /--add-label cw-feedback:new --remove-label cw-feedback:hold/, 'SKILL must show how to release a hold');
});

test('cw-resolve SKILL clarifies holds are not released through it', () => {
  const skill = readFileSync(join(here, '..', '..', 'cw-resolve', 'SKILL.md'), 'utf8');
  assert.match(skill, /cw-feedback:hold/, 'cw-resolve SKILL must mention the hold label');
  assert.match(skill, /not.*cw-resolve|not.*through this inbox|hand-swap/i, 'cw-resolve SKILL must state holds are released by hand, not via cw-resolve');
});
