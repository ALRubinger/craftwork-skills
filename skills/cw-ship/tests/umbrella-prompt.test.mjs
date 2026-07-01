// Regression guard for #71: cw-ship's umbrella producer must stamp the umbrella's
// OWN state label `cw-umbrella:ready` (single "ready for orchestration" marker)
// WITHOUT weakening the milestone-tier prohibition — the stamp is the umbrella's
// own state label, distinct from the human-owned milestone/roadmap tier ABOVE it,
// and it is NOT a mirror of the native sub-issue graph (no-duplicated-state).
//
// Like claim-state-machine.test.mjs / park-prompt.test.mjs, umbrellaPrompt is a
// non-exported template-string builder, so we assert against the extracted source.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const workflowSrc = readFileSync(join(here, '..', 'workflow.js'), 'utf8');

// Slice a `const NAME = ...` builder up to the next top-level `const NAME =`
// declaration — the same nesting-tolerant anchor the sibling tests use.
function extractConst(src, name) {
  const start = src.indexOf(`const ${name} =`);
  assert.notEqual(start, -1, `const ${name} not found in workflow.js`);
  const next = src.indexOf('\nconst ', start + 1);
  assert.notEqual(next, -1, `no declaration follows ${name}`);
  return src.slice(start, next);
}

// --- (a) lazy-create of the cw-umbrella:ready label ---------------------------

test('umbrellaPrompt lazily creates cw-umbrella:ready with color 5319E7', () => {
  const src = extractConst(workflowSrc, 'umbrellaPrompt');
  const create = src.match(/gh label create cw-umbrella:ready[^`]*/);
  assert.ok(create, 'umbrellaPrompt must lazily create the cw-umbrella:ready label');
  assert.match(create[0], /--color 5319E7/, 'the label must be created with color 5319E7');
  assert.match(create[0], /2>\/dev\/null \|\| true/, 'the lazy-create must be idempotent (|| true)');
});

// --- (b) stamp the freshly filed umbrella -------------------------------------

test('umbrellaPrompt stamps cw-umbrella:ready on the just-filed umbrella', () => {
  const src = extractConst(workflowSrc, 'umbrellaPrompt');
  assert.match(
    src,
    /gh issue edit[^`]*--add-label cw-umbrella:ready/,
    'umbrellaPrompt must apply cw-umbrella:ready to the umbrella via gh issue edit',
  );
});

// --- (c) regression: the milestone-tier prohibition is NOT weakened -----------

test('umbrellaPrompt still forbids applying a milestone/roadmap-tier label', () => {
  const src = extractConst(workflowSrc, 'umbrellaPrompt');
  assert.match(src, /Do NOT apply a milestone\/roadmap-tier label/, 'the milestone-tier prohibition must remain verbatim');
  assert.match(src, /human-owned tier ABOVE the umbrella/, 'must still describe the milestone as a human-owned tier ABOVE the umbrella');
  assert.match(src, /never create/, 'must still say the skills never create the milestone tier');
  // The stamp must be framed as the umbrella's OWN state label, not the tier-above.
  assert.match(src, /own state label/i, 'cw-umbrella:ready must be framed as the umbrella\'s own state label');
});

// --- (d) the contract doc documents the label + no-duplicated-state -----------

test('state-machine.md documents cw-umbrella:ready, its color, and that it is not a mirror', () => {
  const doc = readFileSync(join(here, '..', 'references', 'state-machine.md'), 'utf8');
  assert.match(doc, /cw-umbrella:ready/, 'doc must name the cw-umbrella:ready label');
  assert.match(doc, /5319E7/, 'doc must record the cw-umbrella:ready color 5319E7');
  assert.match(
    doc,
    /NOT a mirror|not a mirror|no-duplicated-state/i,
    'doc must state cw-umbrella:ready is not a mirror of the native sub-issue graph',
  );
  assert.match(doc, /read-only/i, 'doc must state cw-orchestrate consumes it read-only');
});
