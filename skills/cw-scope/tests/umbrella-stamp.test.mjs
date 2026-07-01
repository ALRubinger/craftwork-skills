// Regression guard for #71 / #73: cw-scope is the OTHER producer that files an
// umbrella, so its creation recipe must stamp the umbrella's own state label
// `cw-umbrella:ready` (the single "ready for orchestration" marker) exactly like
// cw-ship does. The recipe lives in references/issue-templates.md as LLM prose,
// so nothing goes red if a future edit silently drops the stamp — this test pins
// it. Mirrors cw-ship's tests/umbrella-prompt.test.mjs; auto-discovered by CI's
// `node --test 'skills/*/tests/*.test.mjs'` glob.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const recipe = readFileSync(
  join(here, '..', 'references', 'issue-templates.md'),
  'utf8',
);

// --- (a) lazy-create of the cw-umbrella:ready label ---------------------------

test('cw-scope creation recipe lazily creates cw-umbrella:ready with color 5319E7', () => {
  assert.match(
    recipe,
    /gh label create cw-umbrella:ready --color 5319E7/,
    'the recipe must lazily create the cw-umbrella:ready label with color 5319E7',
  );
});

// --- (b) stamp the freshly filed umbrella -------------------------------------

test('cw-scope creation recipe stamps cw-umbrella:ready on the just-filed umbrella', () => {
  assert.match(
    recipe,
    /gh issue edit "\$UMB" --add-label cw-umbrella:ready/,
    'the recipe must apply cw-umbrella:ready to the umbrella via gh issue edit',
  );
});

// --- (c) regression: the milestone-tier prohibition is NOT weakened -----------

test('cw-scope recipe still forbids applying a milestone/roadmap-tier label', () => {
  assert.match(
    recipe,
    /Do \*\*not\*\* apply a milestone\/roadmap-tier label/,
    'the milestone-tier prohibition must remain in the recipe prose',
  );
  assert.match(
    recipe,
    /own state label/i,
    "cw-umbrella:ready must be framed as the umbrella's own state label",
  );
});
