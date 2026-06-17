// Drift guard: workflow.js inlines a mirror of scheduler.mjs's pure functions
// (a Workflow script cannot import sibling modules at runtime). This test fails
// if the two copies diverge, so the tested canonical and the running copy stay
// in lockstep.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

// Extract a top-level `function NAME(...) { ... }` block by brace matching.
function extractFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `function ${name} not found`);
  let depth = 0;
  let i = src.indexOf('{', start);
  const bodyStart = i;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(bodyStart, i + 1);
    }
  }
  throw new Error(`unbalanced braces extracting ${name}`);
}

// Compare logic, not commentary: strip `//` line comments, then collapse
// whitespace. (Safe here — no string literal in these functions contains `//`.)
const normalize = (s) =>
  s
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n')
    .replace(/\s+/g, ' ')
    .trim();

const schedulerSrc = readFileSync(join(root, 'scheduler.mjs'), 'utf8');
const triageSrc = readFileSync(join(root, 'triage.mjs'), 'utf8');
const mergeCiSrc = readFileSync(join(root, 'merge-ci.mjs'), 'utf8');
const workflowSrc = readFileSync(join(root, 'workflow.js'), 'utf8');

for (const fn of ['computeWaves', 'transitiveDependents']) {
  test(`workflow.js mirror of ${fn} matches scheduler.mjs`, () => {
    const canonical = normalize(extractFunction(schedulerSrc, fn));
    const mirror = normalize(extractFunction(workflowSrc, fn));
    assert.equal(mirror, canonical, `${fn} has drifted between scheduler.mjs and workflow.js`);
  });
}

for (const fn of [
  'closeDisposition',
  'highConfidenceFixes',
  'autofixCandidates',
  'escalations',
  'deferredResiduals',
]) {
  test(`workflow.js mirror of ${fn} matches triage.mjs`, () => {
    const canonical = normalize(extractFunction(triageSrc, fn));
    const mirror = normalize(extractFunction(workflowSrc, fn));
    assert.equal(mirror, canonical, `${fn} has drifted between triage.mjs and workflow.js`);
  });
}

for (const fn of ['classifyPostMergeCI', 'postMergeCIStalls', 'mergeVerdict']) {
  test(`workflow.js mirror of ${fn} matches merge-ci.mjs`, () => {
    const canonical = normalize(extractFunction(mergeCiSrc, fn));
    const mirror = normalize(extractFunction(workflowSrc, fn));
    assert.equal(mirror, canonical, `${fn} has drifted between merge-ci.mjs and workflow.js`);
  });
}
