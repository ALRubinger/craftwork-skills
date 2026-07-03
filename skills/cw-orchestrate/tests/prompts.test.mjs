// Tests for the canonical role-prompt builders in prompts.mjs.
//
// REGRESSION (byte-identity): every rendered prompt is byte-for-byte the
// captured single-branch output. The goldens in prompts.goldens.json were
// captured from the original workflow.js builders; this guards against any
// accidental drift (the self-modifying-run safety bar). Every run targets
// `defaultBranch` — plan/work/autofix fetch and branch off it, the squash-merge
// lands on it, and merge-tree checks the diff against it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { planPrompt, workPrompt, mergePrompt, triagePrompt, autofixPrompt } from '../prompts.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const goldens = JSON.parse(readFileSync(join(here, 'prompts.goldens.json'), 'utf8'));

// Fixtures mirror the ones used to capture the goldens. Do not change without
// regenerating prompts.goldens.json from the canonical builders.
const baseManifest = { repo: 'o/r', defaultBranch: 'main', umbrella: 99 };
const node = { issue: 7, plan_markdown: 'PLAN' };
const built = { pr_number: 12, pr_url: 'http://pr/12', branch: 'feat/x', issue: 7 };

// --- Regression: byte-identity against the captured goldens ---

test('workPrompt is byte-identical to the captured golden', () => {
  assert.equal(workPrompt(baseManifest, node), goldens.workPrompt);
});

test('mergePrompt is byte-identical to the captured golden', () => {
  assert.equal(mergePrompt(baseManifest, built), goldens.mergePrompt);
});

test('triagePrompt (no PR hint) is byte-identical to the captured golden', () => {
  assert.equal(triagePrompt(baseManifest, 7, 'http://res/1', null), goldens.triagePrompt_nohint);
});

test('triagePrompt (with PR hint) is byte-identical to the captured golden', () => {
  assert.equal(triagePrompt(baseManifest, 7, 'http://res/1', 'http://pr/12'), goldens.triagePrompt_hint);
});

test('planPrompt is byte-identical to the captured golden', () => {
  assert.equal(planPrompt(baseManifest, { number: 7, title: 'Title' }, 'BRIEF'), goldens.planPrompt);
});

// --- Every branch reference resolves to defaultBranch ---

test('workPrompt forks off defaultBranch and opens no explicit --base', () => {
  const p = workPrompt(baseManifest, node);
  assert.ok(p.includes('Create a branch off fresh `main`'));
  assert.ok(!p.includes('gh pr create --base'));
});

test('mergePrompt merges to defaultBranch', () => {
  const p = mergePrompt(baseManifest, built);
  assert.match(p, /SERIALIZED merge of one already-built PR to `main`/);
  assert.match(p, /git fetch origin main feat\/x`/);
  assert.match(p, /git merge-tree --write-tree --name-only origin\/main origin\/feat\/x`/);
});

const planIssue = { number: 7, title: 'Title' };
const briefText = 'BRIEF';

test('planPrompt grounds against defaultBranch', () => {
  const p = planPrompt(baseManifest, planIssue, briefText);
  assert.ok(p.includes('git fetch origin main -q'));
  assert.ok(p.includes('read the relevant files at `origin/main` HEAD'));
});

// --- Model routing (feedback #85): the plan step routes the build ---

test('planPrompt cites the shared complexity rubric and asks for a routing block', () => {
  const p = planPrompt(baseManifest, planIssue, briefText);
  assert.ok(p.includes('references/complexity-rubric.md'), 'must cite the shared rubric file');
  assert.ok(p.includes('ROUTE THE BUILD'));
  assert.match(p, /Return structured output: \{ issue, plan_markdown, ownership_paths, routing: \{ provider, model, effort, complexity, rationale \} \}\./);
});

test('planPrompt encodes the route-up bias (opus default, positive evidence for lower tiers)', () => {
  const p = planPrompt(baseManifest, planIssue, briefText);
  assert.ok(p.includes('Route UP when uncertain'));
  assert.ok(p.includes('model "opus" is the DEFAULT'));
  assert.ok(p.includes('POSITIVE EVIDENCE of mechanical work'));
  assert.ok(p.includes('Effort is a second dial'));
  assert.ok(p.includes('"opus" at "low" effort is a valid route for mechanical work'));
});

test('planPrompt encodes the escalate-only operator override and the no-write-back rule', () => {
  const p = planPrompt(baseManifest, planIssue, briefText);
  assert.ok(p.includes('"Routing: <tier>" line'));
  assert.ok(p.includes('FLOOR — you may route above it, never below it'));
  assert.ok(p.includes('NEVER write it back to the issue'));
});

test('planPrompt keeps the provider seam open but pins the v1 enums', () => {
  const p = planPrompt(baseManifest, planIssue, briefText);
  assert.ok(p.includes('v1 executes Claude tiers only'));
  assert.ok(p.includes('"fable"|"opus"|"sonnet"|"haiku"'));
  assert.ok(p.includes('"low"|"medium"|"high"|"xhigh"|"max"'));
  assert.ok(p.includes('"mechanical"|"standard"|"complex"'));
});

const autofixTr = {
  residual_issue: 1010,
  sub_issue: 984,
  findings: [{ title: 'A', verdict: 'FIX_NOW', confidence: 'high', fix_hint: 'do A', rationale: 'because A' }],
};

test('autofixPrompt forks + prechecks against defaultBranch', () => {
  const p = autofixPrompt(baseManifest, autofixTr);
  assert.ok(p.includes('Branch off fresh `main`'));
  assert.ok(p.includes('git fetch origin main -q'));
  assert.ok(p.includes('already landed on main'));
});

// A tr where a DECISION remains, so closeDisposition !== 'close-via-autofix'.
const autofixTrKeepOpen = {
  residual_issue: 2020,
  sub_issue: 985,
  findings: [
    { title: 'A', verdict: 'FIX_NOW', confidence: 'high', fix_hint: 'do A', rationale: 'because A' },
    { title: 'B', verdict: 'DECISION', decision_question: 'Q?' },
  ],
};

test('autofixPrompt (close-via-autofix): the Closes keyword is conditional on applying EVERY fix', () => {
  const p = autofixPrompt(baseManifest, autofixTr);
  // Regression for #82: a skipped fix must NOT ship `Closes #` and close the residual.
  assert.ok(p.includes('if you applied EVERY listed fix (`skipped_fixes` is empty)'));
  assert.ok(p.includes('if you SKIPPED any fix'));
  assert.ok(p.includes(`Closes #${autofixTr.residual_issue}`));
  assert.ok(p.includes(`Relates to #${autofixTr.residual_issue}`));
  // The old unconditional phrasing is gone.
  assert.ok(!p.includes('these fixes resolve every remaining actionable finding'));
});

test('autofixPrompt: skips are recorded in `skipped_fixes` (step 2 + schema)', () => {
  const p = autofixPrompt(baseManifest, autofixTr);
  assert.ok(p.includes('record it in `skipped_fixes`'));
  assert.match(p, /Return structured output:.*, skipped_fixes }\./);
});

test('autofixPrompt (keep-open disposition) only Relates-to, never Closes', () => {
  const p = autofixPrompt(baseManifest, autofixTrKeepOpen);
  assert.ok(p.includes(`Relates to #${autofixTrKeepOpen.residual_issue}`));
  assert.ok(!p.includes(`Closes #${autofixTrKeepOpen.residual_issue}`));
});

test('triagePrompt shipped-code references point at defaultBranch', () => {
  const p = triagePrompt(baseManifest, 7, 'http://res/1', null);
  assert.ok(p.includes('default branch main'));
  assert.ok(p.includes('current files on main'));
});
