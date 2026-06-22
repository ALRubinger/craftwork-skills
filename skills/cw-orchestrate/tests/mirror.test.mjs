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

// Drift guard for the prompt builders (workPrompt/mergePrompt/triagePrompt):
// these are arrow functions returning template literals, not `function NAME`
// blocks, and workflow.js cannot be imported (it auto-runs + top-level return).
// So compile each builder out of the workflow.js *text* and compare its rendered
// output, for several manifests, against the canonical prompts.mjs export.
//
// Extract `const NAME = <expr>;` where <expr> is the full arrow body (which may
// contain nested template literals). Scan from `=` to the terminating top-level
// `;`, tracking template-literal nesting and `${...}` brace depth so a `;` or `}`
// inside a literal is not mistaken for the declaration end.
function extractDeclExpr(src, name) {
  const marker = `const ${name} = `;
  const start = src.indexOf(marker);
  assert.notEqual(start, -1, `const ${name} not found in workflow.js`);
  let i = start + marker.length;
  const exprStart = i;
  const stack = []; // '`' = inside template, '{' = inside ${} or block
  for (; i < src.length; i++) {
    const c = src[i];
    const top = stack[stack.length - 1];
    if (top === '`') {
      if (c === '\\') { i++; continue; }
      if (c === '`') { stack.pop(); continue; }
      if (c === '$' && src[i + 1] === '{') { stack.push('{'); i++; continue; }
      continue;
    }
    // outside any template literal
    if (c === '`') { stack.push('`'); continue; }
    if (c === '{') { stack.push('{'); continue; }
    if (c === '}') { stack.pop(); continue; }
    if (c === ';' && stack.length === 0) return src.slice(exprStart, i);
  }
  throw new Error(`no terminating ; for const ${name}`);
}

async function workflowBuilder(name) {
  // mergePrompt/triagePrompt close over the `mergeTarget` helper, so pull that
  // dependency in too when compiling the builder out of the workflow.js text.
  const helper = extractDeclExpr(workflowSrc, 'mergeTarget');
  const expr = extractDeclExpr(workflowSrc, name);
  const decls = name === 'mergeTarget' ? `export const mergeTarget = ${helper};`
    : `const mergeTarget = ${helper};\nexport const ${name} = ${expr};`;
  const url = 'data:text/javascript,' + encodeURIComponent(decls);
  return (await import(url))[name];
}

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

// Prompt builders: compare rendered output (not source text) across several
// manifests so a drift in either the default-case or the targetBranch wiring is
// caught. Render the canonical prompts.mjs export and the workflow.js inline
// mirror for each case and assert byte-equality.
import * as canonicalPrompts from '../prompts.mjs';

const promptManifests = [
  { repo: 'o/r', defaultBranch: 'main', umbrella: 99 },
  { repo: 'o/r', defaultBranch: 'main', umbrella: 99, targetBranch: 'main' },
  { repo: 'o/r', defaultBranch: 'main', umbrella: 99, targetBranch: 'integration/foo' },
  { repo: 'o/r', defaultBranch: 'trunk', umbrella: 99, targetBranch: 'release/1.x' },
];
const node = { issue: 7, plan_markdown: 'PLAN' };
const built = { pr_number: 12, pr_url: 'http://pr/12', branch: 'feat/x', issue: 7 };

test('workflow.js workPrompt mirror matches prompts.mjs', async () => {
  const mirror = await workflowBuilder('workPrompt');
  for (const m of promptManifests) {
    assert.equal(mirror(m, node), canonicalPrompts.workPrompt(m, node), `workPrompt drifted (target=${m.targetBranch})`);
  }
});

test('workflow.js mergePrompt mirror matches prompts.mjs', async () => {
  const mirror = await workflowBuilder('mergePrompt');
  for (const m of promptManifests) {
    assert.equal(mirror(m, built), canonicalPrompts.mergePrompt(m, built), `mergePrompt drifted (target=${m.targetBranch})`);
  }
});

test('workflow.js triagePrompt mirror matches prompts.mjs', async () => {
  const mirror = await workflowBuilder('triagePrompt');
  for (const m of promptManifests) {
    for (const hint of [null, 'http://pr/12']) {
      assert.equal(
        mirror(m, 7, 'http://res/1', hint),
        canonicalPrompts.triagePrompt(m, 7, 'http://res/1', hint),
        `triagePrompt drifted (target=${m.targetBranch}, hint=${hint})`,
      );
    }
  }
});
