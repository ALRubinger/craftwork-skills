import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CLAIM_TIMEOUT_MS,
  isClaimStale,
  resolveOwner,
  ownsClaim,
  isReclaimable,
} from '../claim.mjs';

// A fixed "now" so tests are deterministic (the module never reads the clock).
const NOW = Date.parse('2026-06-18T12:00:00Z');
const live = { nowMs: NOW, hasOpenPR: false, issueUpdatedAt: '2026-06-18T11:59:00Z' }; // updated 1 min ago
const at = (minsAgo) => new Date(NOW - minsToMs(minsAgo)).toISOString();
const minsToMs = (m) => m * 60 * 1000;

// --- (1) Two concurrent runs claim the same issue → exactly one wins ----------

test('two concurrent claims: the earlier created_at owns; the later yields', () => {
  const claims = [
    { id: 200, created_at: at(2) }, // 2 min ago — earlier
    { id: 201, created_at: at(1) }, // 1 min ago — later
  ];
  const owner = resolveOwner(claims, live);
  assert.equal(owner.id, 200);
  assert.equal(ownsClaim(200, claims, live), true);
  assert.equal(ownsClaim(201, claims, live), false); // loser yields
});

test('two claims in the same second: lowest comment id breaks the tie', () => {
  const same = '2026-06-18T11:58:00Z';
  const claims = [
    { id: 305, created_at: same },
    { id: 299, created_at: same },
  ];
  assert.equal(resolveOwner(claims, live).id, 299);
  assert.equal(ownsClaim(299, claims, live), true);
  assert.equal(ownsClaim(305, claims, live), false);
});

test('exactly one owner across N racing claims', () => {
  const claims = [
    { id: 5, created_at: at(3) },
    { id: 6, created_at: at(5) }, // earliest
    { id: 7, created_at: at(1) },
  ];
  const winners = [5, 6, 7].filter((id) => ownsClaim(id, claims, live));
  assert.deepEqual(winners, [6]);
});

// --- (2) A crashed/stale claim is reclaimable by age --------------------------

test('isClaimStale: old claim, no open PR, idle issue → stale', () => {
  const ctx = { nowMs: NOW, hasOpenPR: false, issueUpdatedAt: at(200) }; // issue idle >2h
  assert.equal(isClaimStale({ created_at: at(200) }, ctx), true); // claim >2h old
});

test('isClaimStale: an open PR keeps a claim live no matter how old', () => {
  const ctx = { nowMs: NOW, hasOpenPR: true, issueUpdatedAt: at(500) };
  assert.equal(isClaimStale({ created_at: at(500) }, ctx), false);
});

test('isClaimStale: recently-updated issue is not stale even with an old claim', () => {
  const ctx = { nowMs: NOW, hasOpenPR: false, issueUpdatedAt: at(5) }; // updated 5 min ago
  assert.equal(isClaimStale({ created_at: at(300) }, ctx), false);
});

test('reclaim: a fresh claim wins over a crashed (stale) prior claim', () => {
  const ctx = { nowMs: NOW, hasOpenPR: false, issueUpdatedAt: at(300) };
  const claims = [
    { id: 100, created_at: at(300) }, // crashed run, 5h ago
    { id: 400, created_at: at(1) }, // reclaiming run, fresh
  ];
  assert.equal(resolveOwner(claims, ctx).id, 400);
  assert.equal(ownsClaim(400, claims, ctx), true);
});

test('isReclaimable: only-stale claims → reclaimable; a live claim → not', () => {
  const idleCtx = { nowMs: NOW, hasOpenPR: false, issueUpdatedAt: at(300) };
  assert.equal(isReclaimable([{ id: 1, created_at: at(300) }], idleCtx), true);
  assert.equal(isReclaimable([], idleCtx), true); // triaging with no claim (legacy) → reclaimable
  assert.equal(isReclaimable([{ id: 2, created_at: at(1) }], live), false); // live claim → held
});

// --- (3) Discovery excludes in-flight (live) claims ---------------------------

test('discovery rule: an in-flight live claim is NOT reclaimable (excluded)', () => {
  // A run is actively building (open PR), claim 10 min old.
  const buildingCtx = { nowMs: NOW, hasOpenPR: true, issueUpdatedAt: at(10) };
  const claims = [{ id: 50, created_at: at(10) }];
  assert.equal(isReclaimable(claims, buildingCtx), false);
  assert.equal(resolveOwner(claims, buildingCtx).id, 50);
});

test('the timeout constant is 2 hours', () => {
  assert.equal(CLAIM_TIMEOUT_MS, 2 * 60 * 60 * 1000);
});

test('tolerates null/empty claim sets', () => {
  assert.equal(resolveOwner([], live), null);
  assert.equal(resolveOwner(null, live), null);
  assert.equal(resolveOwner([null], live), null);
});
