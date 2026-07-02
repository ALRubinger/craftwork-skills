// Regression tests for the two coupled residual-triage/autofix defects behind #82
// (observed on #75/#70): a consume-mode feature-sized answer misclassified as a
// high-confidence FIX_NOW, and a `Closes #` keyword baked in before the autofix
// subagent knows whether it applied every fix. Both live in workflow.js prompt
// strings (cw-sweep has no separate canonical prompts.mjs), so these tests compile
// the inline builders out of the workflow.js *text* and assert on rendered output.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const workflowSrc = readFileSync(join(here, '..', 'workflow.js'), 'utf8');

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

// Extract `const NAME = <expr>` where <expr> is an arrow body that may contain
// nested template literals and `${...}` interpolations. Scan to the terminating
// top-level `;`. (Same technique as cw-orchestrate's mirror.test.)
function extractDeclExpr(src, name) {
  const marker = `const ${name} = `;
  const start = src.indexOf(marker);
  assert.notEqual(start, -1, `const ${name} not found in workflow.js`);
  let i = start + marker.length;
  const exprStart = i;
  const stack = [];
  for (; i < src.length; i++) {
    const c = src[i];
    const top = stack[stack.length - 1];
    if (top === '`') {
      if (c === '\\') { i++; continue; }
      if (c === '`') { stack.pop(); continue; }
      if (c === '$' && src[i + 1] === '{') { stack.push('{'); i++; continue; }
      continue;
    }
    if (c === '`') { stack.push('`'); continue; }
    if (c === '{') { stack.push('{'); continue; }
    if (c === '}') { stack.pop(); continue; }
    if (c === ';' && stack.length === 0) return src.slice(exprStart, i);
  }
  throw new Error(`no terminating ; for const ${name}`);
}

async function builder(decls, name) {
  const url = 'data:text/javascript,' + encodeURIComponent(decls);
  return (await import(url))[name];
}

const cfg = { repo: 'o/r', defaultBranch: 'main' };

// --- Prong (a): consume-mode misclassification of feature-sized answers --------

test('triagePrompt consume mode: small vs feature-sized answers are classified apart', async () => {
  const triagePrompt = await builder(
    `export const triagePrompt = ${extractDeclExpr(workflowSrc, 'triagePrompt')};`,
    'triagePrompt',
  );
  const p = triagePrompt(cfg, 986, 'http://res/1000', [], 'consume');

  // A small, bounded authorized change still autofixes at high confidence.
  assert.ok(p.includes('answer specifies a SMALL, bounded change'));
  assert.ok(p.includes('FIX_NOW, confidence "high"'));

  // A feature-sized/broad authorized change is explicitly NOT high-confidence and
  // re-parks instead of routing to close-via-autofix.
  assert.ok(p.includes('answer authorizes a FEATURE-SIZED or BROAD change'));
  assert.ok(p.includes('do NOT mark it high-confidence'));
  assert.ok(p.includes('keep DECISION'));
  assert.ok(p.includes('cw-review-residual:needs-input'));

  // The old unconditional rule (any "do X" => high-confidence) is gone.
  assert.ok(!p.includes('answer specifies a change ("do X", "use Y") => FIX_NOW'));
});

test('triagePrompt fresh mode carries no CONSUME MODE block', async () => {
  const triagePrompt = await builder(
    `export const triagePrompt = ${extractDeclExpr(workflowSrc, 'triagePrompt')};`,
    'triagePrompt',
  );
  const p = triagePrompt(cfg, 986, 'http://res/1000', [], 'fresh');
  assert.ok(!p.includes('CONSUME MODE'));
});

// --- Prong (b): conditional Closes keyword + skipped_fixes signal --------------

const closeViaAutofixTr = {
  residual_issue: 1010,
  sub_issue: 984,
  findings: [{ title: 'A', verdict: 'FIX_NOW', confidence: 'high', fix_hint: 'do A', rationale: 'because A' }],
};
const keepOpenTr = {
  residual_issue: 2020,
  sub_issue: 985,
  findings: [
    { title: 'A', verdict: 'FIX_NOW', confidence: 'high', fix_hint: 'do A', rationale: 'because A' },
    { title: 'B', verdict: 'DECISION', decision_question: 'Q?' },
  ],
};

async function autofixBuilder() {
  const fnDecl = (name) => `function ${name}(result) ${extractFunction(workflowSrc, name)}`;
  const decls =
    `${fnDecl('highConfidenceFixes')}\n` +
    `${fnDecl('closeDisposition')}\n` +
    `export const autofixPrompt = ${extractDeclExpr(workflowSrc, 'autofixPrompt')};`;
  return builder(decls, 'autofixPrompt');
}

test('autofixPrompt (close-via-autofix): the Closes keyword is conditional on applying EVERY fix', async () => {
  const autofixPrompt = await autofixBuilder();
  const p = autofixPrompt(cfg, closeViaAutofixTr);
  assert.ok(p.includes('if you applied EVERY listed fix (`skipped_fixes` is empty)'));
  assert.ok(p.includes('if you SKIPPED any fix'));
  assert.ok(p.includes(`Closes #${closeViaAutofixTr.residual_issue}`));
  assert.ok(p.includes(`Relates to #${closeViaAutofixTr.residual_issue}`));
  assert.ok(!p.includes('these fixes resolve every remaining actionable finding'));
});

test('autofixPrompt: skips are recorded in `skipped_fixes` (step 2 + return schema)', async () => {
  const autofixPrompt = await autofixBuilder();
  const p = autofixPrompt(cfg, closeViaAutofixTr);
  assert.ok(p.includes('record it in `skipped_fixes`'));
  assert.match(p, /Return structured output:.*, skipped_fixes }\./);
});

test('autofixPrompt (keep-open disposition) only Relates-to, never Closes', async () => {
  const autofixPrompt = await autofixBuilder();
  const p = autofixPrompt(cfg, keepOpenTr);
  assert.ok(p.includes(`Relates to #${keepOpenTr.residual_issue}`));
  assert.ok(!p.includes(`Closes #${keepOpenTr.residual_issue}`));
});
