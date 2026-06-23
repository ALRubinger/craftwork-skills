// Tests for the canonical role-prompt builders in prompts.mjs.
//
// Two load-bearing properties:
//   1. REGRESSION (byte-identity): with no `targetBranch` (or `targetBranch`
//      equal to `defaultBranch`), every rendered prompt is byte-for-byte the
//      pre-change single-branch output. The goldens in prompts.goldens.json were
//      captured from the original workflow.js builders; this guards against any
//      accidental drift in the no-op path (the self-modifying-run safety bar).
//   2. INTEGRATION RETARGET: with a distinct `targetBranch`, the merge target,
//      merge-tree base, conflict cause, post-merge tip, and triage shipped-code
//      references point at the target — AND the fork base for plan/work/autofix
//      moves to the target too (it carries the run's accumulated work, kept fresh
//      from `defaultBranch` by the Step 4.5 ensure). The merge-tree's freshness
//      leg of the fetch still names `defaultBranch`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { planPrompt, workPrompt, mergePrompt, triagePrompt, autofixPrompt, mergeTarget } from '../prompts.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const goldens = JSON.parse(readFileSync(join(here, 'prompts.goldens.json'), 'utf8'));

// Fixtures mirror the ones used to capture the goldens. Do not change without
// regenerating prompts.goldens.json from the canonical (pre-change) builders.
const baseManifest = { repo: 'o/r', defaultBranch: 'main', umbrella: 99 };
const node = { issue: 7, plan_markdown: 'PLAN' };
const built = { pr_number: 12, pr_url: 'http://pr/12', branch: 'feat/x', issue: 7 };

test('mergeTarget falls back to defaultBranch when targetBranch is absent', () => {
  assert.equal(mergeTarget(baseManifest), 'main');
});

test('mergeTarget uses targetBranch when present', () => {
  assert.equal(mergeTarget({ ...baseManifest, targetBranch: 'integration/foo' }), 'integration/foo');
});

test('mergeTarget honors an intentional empty string (?? not ||)', () => {
  // `??` means an explicit empty string is NOT replaced; only absent falls back.
  assert.equal(mergeTarget({ ...baseManifest, targetBranch: '' }), '');
});

// --- Regression: byte-identity for the no-target (single-branch) path ---

test('workPrompt is byte-identical to the captured golden (no targetBranch)', () => {
  assert.equal(workPrompt(baseManifest, node), goldens.workPrompt);
});

test('mergePrompt is byte-identical to the captured golden (no targetBranch)', () => {
  assert.equal(mergePrompt(baseManifest, built), goldens.mergePrompt);
});

test('triagePrompt (no PR hint) is byte-identical to the captured golden', () => {
  assert.equal(triagePrompt(baseManifest, 7, 'http://res/1', null), goldens.triagePrompt_nohint);
});

test('triagePrompt (with PR hint) is byte-identical to the captured golden', () => {
  assert.equal(triagePrompt(baseManifest, 7, 'http://res/1', 'http://pr/12'), goldens.triagePrompt_hint);
});

// --- Default-equals invariant: absent === targetBranch:defaultBranch ---

test('targetBranch === defaultBranch produces identical output to absent', () => {
  const m = { ...baseManifest, targetBranch: 'main' };
  assert.equal(mergePrompt(m, built), mergePrompt(baseManifest, built));
  assert.equal(triagePrompt(m, 7, 'http://res/1', null), triagePrompt(baseManifest, 7, 'http://res/1', null));
  assert.equal(workPrompt(m, node), workPrompt(baseManifest, node));
});

// --- Integration retarget: distinct targetBranch ---

const integ = { ...baseManifest, targetBranch: 'integration/foo' };

test('mergePrompt retargets the merge target, merge-tree base, cause and tip', () => {
  const p = mergePrompt(integ, built);
  // Heading: merge target.
  assert.match(p, /SERIALIZED merge of one already-built PR to `integration\/foo`/);
  // Fetch list dedups: freshness base (main) + target + branch, in order.
  assert.match(p, /git fetch origin main integration\/foo feat\/x`/);
  // merge-tree base is the target (the branch the PR lands on).
  assert.match(p, /git merge-tree --write-tree --name-only origin\/integration\/foo origin\/feat\/x`/);
  // Conflict cause + rebase prose point at the target.
  assert.ok(p.includes('rebase of the branch onto fresh integration/foo'));
  assert.ok(p.includes('cause "pre-merge conflict against integration/foo"'));
  // Post-merge tip is the target's tip.
  assert.ok(p.includes('a later commit landed on `integration/foo`'));
  assert.ok(p.includes('confirm on the `integration/foo` TIP'));
  // The base (main) is NOT used as a merge target anywhere it shouldn't be:
  // the only remaining `main` is the freshness leg of the fetch.
  assert.equal((p.match(/\bmain\b/g) || []).length, 1);
});

test('workPrompt forks off the merge target and opens the PR against it', () => {
  const p = workPrompt(integ, node);
  // Fork base: the implementing subagent branches off the merge target, which
  // carries the run's accumulated work — NOT the default branch.
  assert.ok(p.includes('Create a branch off fresh `integration/foo`'));
  assert.ok(!p.includes('Create a branch off fresh `main`'));
  // The default branch is still surfaced as the conventional base for prose.
  assert.ok(p.includes('base main'));
  // Merge target: the PR must be opened against the target, else the squash
  // lands on the wrong branch.
  assert.ok(p.includes('gh pr create --base integration/foo'));
  // The parenthetical names the target as fork base + the freshness source.
  assert.ok(p.includes('you branched off `integration/foo`'));
  assert.ok(p.includes('kept fresh from `main`'));
});

test('workPrompt omits the --base clause entirely when target === defaultBranch (byte-identity)', () => {
  const p = workPrompt({ ...baseManifest, targetBranch: 'main' }, node);
  assert.ok(!p.includes('gh pr create --base'));
  assert.equal(p, goldens.workPrompt);
});

// --- planPrompt: fork-base grounding ---

const planIssue = { number: 7, title: 'Title' };
const briefText = 'BRIEF';

test('planPrompt grounds against defaultBranch when no target is set', () => {
  const p = planPrompt(baseManifest, planIssue, briefText);
  assert.ok(p.includes('git fetch origin main -q'));
  assert.ok(p.includes('read the relevant files at `origin/main` HEAD'));
});

test('planPrompt grounds against the merge target when set', () => {
  const p = planPrompt(integ, planIssue, briefText);
  assert.ok(p.includes('git fetch origin integration/foo -q'));
  assert.ok(p.includes('read the relevant files at `origin/integration/foo` HEAD'));
});

test('planPrompt with target === defaultBranch is byte-identical to absent', () => {
  assert.equal(
    planPrompt({ ...baseManifest, targetBranch: 'main' }, planIssue, briefText),
    planPrompt(baseManifest, planIssue, briefText),
  );
});

// --- autofixPrompt: fork + freshness precheck against the target ---

const autofixTr = {
  residual_issue: 1010,
  sub_issue: 984,
  findings: [{ title: 'A', verdict: 'FIX_NOW', confidence: 'high', fix_hint: 'do A', rationale: 'because A' }],
};

test('autofixPrompt forks + prechecks against defaultBranch when no target is set', () => {
  const p = autofixPrompt(baseManifest, autofixTr);
  assert.ok(p.includes('Branch off fresh `main`'));
  assert.ok(p.includes('git fetch origin main -q'));
  assert.ok(p.includes('already landed on main'));
});

test('autofixPrompt forks + prechecks against the merge target when set', () => {
  const p = autofixPrompt(integ, autofixTr);
  assert.ok(p.includes('Branch off fresh `integration/foo`'));
  assert.ok(!p.includes('Branch off fresh `main`'));
  assert.ok(p.includes('git fetch origin integration/foo -q'));
  assert.ok(p.includes('already landed on integration/foo'));
  assert.ok(p.includes('already present (an equivalent guard'));
});

test('autofixPrompt with target === defaultBranch is byte-identical to absent', () => {
  assert.equal(
    autofixPrompt({ ...baseManifest, targetBranch: 'main' }, autofixTr),
    autofixPrompt(baseManifest, autofixTr),
  );
});

test('triagePrompt shipped-code references point at the target', () => {
  const p = triagePrompt(integ, 7, 'http://res/1', null);
  assert.ok(p.includes('default branch integration/foo'));
  assert.ok(p.includes('current files on integration/foo'));
  assert.ok(!p.includes('default branch main'));
});
