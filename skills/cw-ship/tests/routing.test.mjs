// Model routing (feedback #85): the fable-pinned plan step judges each
// feedback issue against the shared complexity rubric
// (../cw-orchestrate/references/complexity-rubric.md) and emits a routing
// block; the workflow pins planning to fable and dispatches the build agent on
// the routed model + effort, defaulting UP to opus when routing is unavailable
// or not executable in v1 (Claude tiers only).
//
// planPrompt and the agent() dispatch are non-exported source inside
// workflow.js, so — like park-prompt.test.mjs — the prompt/dispatch assertions
// run against the extracted source text.

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
    routedAgentOpts({ provider: 'claude', model: 'haiku', effort: 'medium' }),
    { model: 'haiku', effort: 'medium' },
  );
  assert.deepEqual(
    routedAgentOpts({ provider: 'claude', model: 'opus', effort: 'low' }),
    { model: 'opus', effort: 'low' },
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
    routedAgentOpts({ provider: 'codex', model: 'haiku', effort: 'low' }),
    { model: 'opus' },
  );
});

test('an unknown model defaults up to opus; an invalid effort is dropped', () => {
  assert.deepEqual(
    routedAgentOpts({ provider: 'claude', model: 'gpt-5', effort: 'high' }),
    { model: 'opus' },
  );
  assert.deepEqual(
    routedAgentOpts({ provider: 'claude', model: 'fable', effort: 'turbo' }),
    { model: 'fable' },
  );
});

// --- PLAN_SCHEMA carries the routing block ---

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

test('PLAN_SCHEMA requires a routing block (nullable only for yielded plans) with the v1 enums', () => {
  const schema = extractObjectLiteral(workflowSrc, 'PLAN_SCHEMA');
  assert.ok(schema.required.includes('routing'), 'routing must be required on every plan');
  const routing = schema.properties.routing;
  assert.deepEqual(routing.type, ['object', 'null'], 'null is reserved for yielded plans');
  assert.deepEqual(routing.required, ['provider', 'model', 'effort', 'complexity', 'rationale']);
  // provider is an OPEN enum — a seam for a future codex/GPT route.
  assert.equal(routing.properties.provider.enum, undefined, 'provider must stay an open enum');
  assert.deepEqual(routing.properties.model.enum, ['fable', 'opus', 'sonnet', 'haiku']);
  assert.deepEqual(routing.properties.effort.enum, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(routing.properties.complexity.enum, ['mechanical', 'standard', 'complex']);
});

// --- planPrompt: rubric-cited routing judgment ---

// Slice from the declaration to the next top-level `const ` (the same
// syntax-light anchor extraction park-prompt.test.mjs uses).
function sliceDecl(src, anchor) {
  const start = src.indexOf(anchor);
  assert.notEqual(start, -1, `${anchor} not found in workflow.js`);
  const next = src.indexOf('\nconst ', start + 1);
  return src.slice(start, next === -1 ? src.length : next);
}

const planPromptSrc = sliceDecl(workflowSrc, 'const planPrompt =');

test('planPrompt cites the shared complexity rubric and asks for a routing block', () => {
  assert.ok(planPromptSrc.includes('cw-orchestrate/references/complexity-rubric.md'), 'must cite the shared rubric file');
  assert.ok(planPromptSrc.includes('ROUTE THE BUILD'));
  assert.ok(planPromptSrc.includes('umbrella_scope, routing }'), 'routing must be in the structured return shape');
});

test('planPrompt encodes the route-up bias (opus default, positive evidence for lower tiers)', () => {
  assert.ok(planPromptSrc.includes('Route UP when uncertain'));
  assert.ok(planPromptSrc.includes('model "opus" is the DEFAULT'));
  assert.ok(planPromptSrc.includes('POSITIVE EVIDENCE of mechanical work'));
  assert.ok(planPromptSrc.includes('Effort is a second dial'));
  assert.ok(planPromptSrc.includes('"opus" at "low" effort is a valid route for mechanical work'));
});

test('planPrompt encodes the escalate-only operator override and the no-write-back rule', () => {
  assert.ok(planPromptSrc.includes('"Routing: <tier>" line'));
  assert.ok(planPromptSrc.includes('FLOOR — you may route above it, never below it'));
  assert.ok(planPromptSrc.includes('NEVER write it back to the issue'));
});

test('planPrompt keeps the provider seam open, pins the v1 enums, and nulls routing only on yield', () => {
  assert.ok(planPromptSrc.includes('v1 executes Claude tiers only'));
  assert.ok(planPromptSrc.includes('"fable"|"opus"|"sonnet"|"haiku"'));
  assert.ok(planPromptSrc.includes('"low"|"medium"|"high"|"xhigh"|"max"'));
  assert.ok(planPromptSrc.includes('"mechanical"|"standard"|"complex"'));
  assert.ok(planPromptSrc.includes('routing = null ONLY on a yielded plan'));
  // The yielded early-return example must satisfy the schema (routing required).
  assert.ok(planPromptSrc.includes('summary: "yielded: <owner claim id> owns this issue", routing: null'));
});

// --- workflow.js dispatch: fable-pinned plan, routed build ---

test('the plan agent is pinned to fable', () => {
  assert.match(
    workflowSrc,
    /label: `plan:\$\{it\.issue\}`,\s*phase: 'Plan',\s*model: 'fable',/,
    'the plan agent() call must pin model: fable',
  );
});

test('the build agent dispatches on the plan-routed model + effort', () => {
  assert.match(
    workflowSrc,
    /label: `build:\$\{p\.issue\}`[\s\S]{0,200}\.\.\.routedAgentOpts\(routing\)/,
    'the build agent() call must spread routedAgentOpts(plan.routing)',
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
