// Model routing (feedback #85): the fable-pinned plan step judges each
// sub-issue against the shared complexity rubric
// (references/complexity-rubric.md) and emits a routing block; the workflow
// pins plan/review to fable and dispatches work/autofix agents on the routed
// model + effort, defaulting UP to opus when routing is unavailable or not
// executable in v1 (Claude tiers only).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { routedAgentOpts } from '../routing.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const workflowSrc = readFileSync(join(here, '..', 'workflow.js'), 'utf8');

// --- routedAgentOpts: the pure dispatch contract ---

test('a valid claude routing passes model + effort through', () => {
  assert.deepEqual(
    routedAgentOpts({ provider: 'claude', model: 'sonnet', effort: 'low' }),
    { model: 'sonnet', effort: 'low' },
  );
  assert.deepEqual(
    routedAgentOpts({ provider: 'claude', model: 'fable', effort: 'max' }),
    { model: 'fable', effort: 'max' },
  );
});

test('missing routing defaults up to opus (route-up bias)', () => {
  assert.deepEqual(routedAgentOpts(null), { model: 'opus' });
  assert.deepEqual(routedAgentOpts(undefined), { model: 'opus' });
  assert.deepEqual(routedAgentOpts({}), { model: 'opus' });
});

test('a non-claude provider is not executable in v1 — defaults up to opus', () => {
  // The provider field is an open seam (codex/GPT later); v1 executes Claude only.
  assert.deepEqual(
    routedAgentOpts({ provider: 'codex', model: 'sonnet', effort: 'low' }),
    { model: 'opus' },
  );
});

test('an unknown model defaults up to opus', () => {
  assert.deepEqual(
    routedAgentOpts({ provider: 'claude', model: 'gpt-5', effort: 'high' }),
    { model: 'opus' },
  );
});

test('an invalid effort is dropped, never guessed', () => {
  assert.deepEqual(
    routedAgentOpts({ provider: 'claude', model: 'haiku', effort: 'turbo' }),
    { model: 'haiku' },
  );
  assert.deepEqual(routedAgentOpts({ provider: 'claude', model: 'opus' }), { model: 'opus' });
});

test('every v1 model and effort tier is accepted', () => {
  for (const model of ['fable', 'opus', 'sonnet', 'haiku']) {
    for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) {
      assert.deepEqual(routedAgentOpts({ provider: 'claude', model, effort }), { model, effort });
    }
  }
});

// --- OWNERSHIP_SCHEMA carries the routing block ---

// Extract `const NAME = { ... };` (a plain object literal — no template
// literals inside) by brace matching, then evaluate it.
function extractObjectLiteral(src, name) {
  const marker = `const ${name} = `;
  const start = src.indexOf(marker);
  assert.notEqual(start, -1, `const ${name} not found in workflow.js`);
  let i = src.indexOf('{', start);
  const exprStart = i;
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return new Function(`return ${src.slice(exprStart, i + 1)};`)();
    }
  }
  throw new Error(`unbalanced braces extracting ${name}`);
}

test('OWNERSHIP_SCHEMA requires a routing block with the v1 enums', () => {
  const schema = extractObjectLiteral(workflowSrc, 'OWNERSHIP_SCHEMA');
  assert.ok(schema.required.includes('routing'), 'routing must be required on every plan');
  const routing = schema.properties.routing;
  assert.equal(routing.type, 'object');
  assert.deepEqual(routing.required, ['provider', 'model', 'effort', 'complexity', 'rationale']);
  // provider is an OPEN enum — a seam for a future codex/GPT route.
  assert.equal(routing.properties.provider.enum, undefined, 'provider must stay an open enum');
  assert.deepEqual(routing.properties.model.enum, ['fable', 'opus', 'sonnet', 'haiku']);
  assert.deepEqual(routing.properties.effort.enum, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(routing.properties.complexity.enum, ['mechanical', 'standard', 'complex']);
});

// --- workflow.js dispatch: fable-pinned plan/review, routed work/autofix ---

// Slice from one anchor to the next top-level `const ` declaration (the same
// syntax-light extraction park-prompt tests use in cw-ship).
function sliceDecl(src, anchor) {
  const start = src.indexOf(anchor);
  assert.notEqual(start, -1, `${anchor} not found in workflow.js`);
  const next = src.indexOf('\nconst ', start + 1);
  return src.slice(start, next === -1 ? src.length : next);
}

test('plan and plan-review agents are pinned to fable', () => {
  const planChainSrc = sliceDecl(workflowSrc, 'const planChain =');
  const pins = planChainSrc.match(/model: 'fable'/g) || [];
  assert.equal(pins.length, 2, 'both the plan and the review agent() calls must pin model: fable');
});

test('work agents dispatch on the plan-routed model + effort', () => {
  assert.match(
    workflowSrc,
    /label: `work:\$\{issue\}`[\s\S]{0,200}\.\.\.routedAgentOpts\(planByIssue\.get\(issue\)\.routing\)/,
    'the Work-phase agent() call must spread routedAgentOpts(plan.routing)',
  );
});

test('autofix agents inherit the parent node routing, defaulting up to opus', () => {
  assert.match(
    workflowSrc,
    /const parentRouting = planByIssue\.get\(tr\.sub_issue\)\?\.routing \|\| null;/,
    'autofix must read the PARENT node routing (optional-chained: default up when unavailable)',
  );
  assert.match(
    workflowSrc,
    /label: `autofix:\$\{residualIssue\}`[\s\S]{0,200}\.\.\.routedAgentOpts\(parentRouting\)/,
    'the autofix agent() call must spread routedAgentOpts(parentRouting)',
  );
});

test('routing is logged (run artifacts + log() are its only homes)', () => {
  assert.match(workflowSrc, /build routed:/, 'the routed decision must surface in log() output');
  // No write-back: routing must never be edited onto an issue.
  assert.ok(
    !/gh issue edit[^`]*routing/i.test(workflowSrc),
    'routing must never be written back to issues',
  );
});
