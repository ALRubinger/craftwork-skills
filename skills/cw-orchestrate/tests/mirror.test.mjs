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
const routingSrc = readFileSync(join(root, 'routing.mjs'), 'utf8');
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
  const expr = extractDeclExpr(workflowSrc, name);
  const decls = `export const ${name} = ${expr};`;
  const url = 'data:text/javascript,' + encodeURIComponent(decls);
  return (await import(url))[name];
}

for (const fn of ['computeWaves', 'eligible', 'transitiveDependents']) {
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
  'parkCandidates',
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

test('workflow.js mirror of routedAgentOpts matches routing.mjs', () => {
  const canonical = normalize(extractFunction(routingSrc, 'routedAgentOpts'));
  const mirror = normalize(extractFunction(workflowSrc, 'routedAgentOpts'));
  assert.equal(mirror, canonical, 'routedAgentOpts has drifted between routing.mjs and workflow.js');
});

// Prompt builders: compare rendered output (not source text) across a couple of
// manifests (varying defaultBranch) so any drift between the canonical
// prompts.mjs export and the workflow.js inline mirror is caught.
import * as canonicalPrompts from '../prompts.mjs';

const promptManifests = [
  { repo: 'o/r', defaultBranch: 'main', umbrella: 99 },
  { repo: 'o/r', defaultBranch: 'trunk', umbrella: 99 },
];
const node = { issue: 7, plan_markdown: 'PLAN' };
const built = { pr_number: 12, pr_url: 'http://pr/12', branch: 'feat/x', issue: 7 };
const planIssue = { number: 7, title: 'Title' };
const briefText = 'BRIEF';

test('workflow.js planPrompt mirror matches prompts.mjs', async () => {
  const mirror = await workflowBuilder('planPrompt');
  for (const m of promptManifests) {
    assert.equal(
      mirror(m, planIssue, briefText),
      canonicalPrompts.planPrompt(m, planIssue, briefText),
      `planPrompt drifted`,
    );
  }
});

test('workflow.js workPrompt mirror matches prompts.mjs', async () => {
  const mirror = await workflowBuilder('workPrompt');
  for (const m of promptManifests) {
    assert.equal(mirror(m, node), canonicalPrompts.workPrompt(m, node), `workPrompt drifted`);
  }
});

test('workflow.js mergePrompt mirror matches prompts.mjs', async () => {
  const mirror = await workflowBuilder('mergePrompt');
  for (const m of promptManifests) {
    assert.equal(mirror(m, built), canonicalPrompts.mergePrompt(m, built), `mergePrompt drifted`);
  }
});

test('workflow.js triagePrompt mirror matches prompts.mjs', async () => {
  const mirror = await workflowBuilder('triagePrompt');
  for (const m of promptManifests) {
    for (const hint of [null, 'http://pr/12']) {
      assert.equal(
        mirror(m, 7, 'http://res/1', hint),
        canonicalPrompts.triagePrompt(m, 7, 'http://res/1', hint),
        `triagePrompt drifted`,
      );
    }
  }
});

// decisionFindings + parkResidualPrompt are arrow consts (not `function NAME`
// blocks) and parkResidualPrompt closes over decisionFindings, so compile the pair
// out of the workflow.js text together and compare rendered output against the
// canonical prompts.mjs exports.
async function workflowParkBuilder(name) {
  const dep = extractDeclExpr(workflowSrc, 'decisionFindings');
  const expr = extractDeclExpr(workflowSrc, name);
  const decls = name === 'decisionFindings'
    ? `export const decisionFindings = ${dep};`
    : `const decisionFindings = ${dep};\nexport const ${name} = ${expr};`;
  const url = 'data:text/javascript,' + encodeURIComponent(decls);
  return (await import(url))[name];
}

const parkTr = {
  residual_issue: 1010,
  sub_issue: 984,
  findings: [
    { title: 'A', verdict: 'DECISION', confidence: null, decision_question: 'Q1?', recommended_answer: 'R1', alt_options: ['Alt1', 'Alt2'] },
    { title: 'B', verdict: 'FIX_NOW', confidence: 'low', decision_question: 'Q2?', recommended_answer: 'R2', alt_options: [] },
    { title: 'C', verdict: 'FIX_NOW', confidence: 'high' }, // excluded — high-conf
    { title: 'D', verdict: 'RESOLVED' }, // excluded
  ],
};

test('workflow.js decisionFindings mirror matches prompts.mjs', async () => {
  const mirror = await workflowParkBuilder('decisionFindings');
  assert.deepEqual(mirror(parkTr), canonicalPrompts.decisionFindings(parkTr));
});

test('workflow.js parkResidualPrompt mirror matches prompts.mjs', async () => {
  const mirror = await workflowParkBuilder('parkResidualPrompt');
  for (const m of promptManifests) {
    assert.equal(
      mirror(m, parkTr, 'http://res/1010'),
      canonicalPrompts.parkResidualPrompt(m, parkTr, 'http://res/1010'),
      `parkResidualPrompt drifted`,
    );
  }
});

// autofixPrompt is an arrow const closing over `highConfidenceFixes` and
// `closeDisposition` (the inlined triage `function` blocks). Compile it out of
// the workflow.js text with both deps so the rendered output can be compared to
// the canonical prompts.mjs export.
async function workflowAutofixBuilder() {
  // extractFunction returns just the `{ ... }` body, so re-attach the signature
  // to rebuild a usable `function NAME(args) { ... }` declaration.
  const fnDecl = (name) => `function ${name}(result) ${extractFunction(workflowSrc, name)}`;
  const expr = extractDeclExpr(workflowSrc, 'autofixPrompt');
  const decls = `${fnDecl('highConfidenceFixes')}\n`
    + `${fnDecl('closeDisposition')}\n`
    + `export const autofixPrompt = ${expr};`;
  const url = 'data:text/javascript,' + encodeURIComponent(decls);
  return (await import(url)).autofixPrompt;
}

const autofixTr = {
  residual_issue: 1010,
  sub_issue: 984,
  findings: [
    { title: 'A', verdict: 'FIX_NOW', confidence: 'high', fix_hint: 'do A', rationale: 'because A' },
    { title: 'B', verdict: 'FIX_NOW', confidence: 'high', fix_hint: 'do B', rationale: 'because B' },
  ],
};
// A tr where a DECISION remains, so closeDisposition !== 'close-via-autofix'
// (exercises the Relates-to branch of the close-vs-relate disposition).
const autofixTrKeepOpen = {
  residual_issue: 2020,
  sub_issue: 985,
  findings: [
    { title: 'A', verdict: 'FIX_NOW', confidence: 'high', fix_hint: 'do A', rationale: 'because A' },
    { title: 'B', verdict: 'DECISION', decision_question: 'Q?' },
  ],
};

test('workflow.js autofixPrompt mirror matches prompts.mjs', async () => {
  const mirror = await workflowAutofixBuilder();
  for (const m of promptManifests) {
    for (const tr of [autofixTr, autofixTrKeepOpen]) {
      assert.equal(
        mirror(m, tr),
        canonicalPrompts.autofixPrompt(m, tr),
        `autofixPrompt drifted (residual=${tr.residual_issue})`,
      );
    }
  }
});

// Cross-render invariant: plan/work/autofix fork off defaultBranch.
test('plan/work/autofix reference defaultBranch as the fork base', () => {
  const def = { repo: 'o/r', defaultBranch: 'main', umbrella: 99 };

  assert.match(canonicalPrompts.planPrompt(def, planIssue, briefText), /git fetch origin main -q/);
  assert.match(canonicalPrompts.workPrompt(def, node), /Create a branch off fresh `main`/);
  assert.match(canonicalPrompts.autofixPrompt(def, autofixTr), /Branch off fresh `main`/);
});
