import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveTarget, integrationBranchFor } from '../target.mjs';

test('deriveTarget: no cw-target label -> defaults (targetBranch null)', () => {
  assert.deepEqual(deriveTarget([]), { targetBranch: null, slug: null });
  assert.deepEqual(deriveTarget(['bug', 'enhancement']), {
    targetBranch: null,
    slug: null,
  });
  // tolerate missing/undefined input
  assert.deepEqual(deriveTarget(undefined), { targetBranch: null, slug: null });
});

test('deriveTarget: single cw-target label -> integration/<slug>', () => {
  assert.deepEqual(deriveTarget(['cw-target:integration-targeting']), {
    targetBranch: 'integration/integration-targeting',
    slug: 'integration-targeting',
  });
});

test('deriveTarget: unrelated labels alongside one cw-target are ignored', () => {
  assert.deepEqual(
    deriveTarget(['bug', 'cw-target:foo', 'cw-status:stalled']),
    { targetBranch: 'integration/foo', slug: 'foo' },
  );
});

test('deriveTarget: multiple cw-target labels -> throws naming both', () => {
  assert.throws(
    () => deriveTarget(['cw-target:foo', 'cw-target:bar']),
    (err) => {
      assert.match(err.message, /multiple cw-target/);
      assert.match(err.message, /cw-target:foo/);
      assert.match(err.message, /cw-target:bar/);
      return true;
    },
  );
});

test('deriveTarget: empty slug (cw-target:) -> throws, no silent fallback', () => {
  assert.throws(() => deriveTarget(['cw-target:']), /empty slug/);
});

test('deriveTarget: whitespace-only slug -> throws, no silent fallback', () => {
  assert.throws(() => deriveTarget(['cw-target:   ']), /empty slug/);
});

test('integrationBranchFor: slug -> integration/<slug>', () => {
  assert.equal(integrationBranchFor('foo'), 'integration/foo');
  assert.equal(
    integrationBranchFor('integration-targeting'),
    'integration/integration-targeting',
  );
});
