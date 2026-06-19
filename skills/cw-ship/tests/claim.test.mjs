import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CLAIM_TIMEOUT_MS,
  CLAIM_LABEL,
  TERMINAL_LABELS,
  isClaimStale,
  resolveOwner,
  ownsClaim,
  isReclaimable,
  violatesClaimInvariant,
  reclaimAtIso,
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

// --- (4) The claim label and the terminal labels are mutually exclusive -------
// Regression for feedback #15: an issue ended up carrying BOTH feedback:triaging
// (the in-flight claim) AND feedback:needs-input (a terminal/parked state) at once.
// The invariant: the claim label and any terminal-state label can never coexist.

test('violatesClaimInvariant: triaging + a terminal label is a violation', () => {
  for (const terminal of TERMINAL_LABELS) {
    assert.equal(
      violatesClaimInvariant([CLAIM_LABEL, terminal]),
      true,
      `${CLAIM_LABEL} + ${terminal} must be flagged as a violation`,
    );
  }
  // The exact both-labels state the operator hit.
  assert.equal(violatesClaimInvariant(['feedback', 'feedback:triaging', 'feedback:needs-input']), true);
});

test('violatesClaimInvariant: triaging alone, or a terminal label alone, is fine', () => {
  assert.equal(violatesClaimInvariant([CLAIM_LABEL]), false);
  assert.equal(violatesClaimInvariant(['feedback', CLAIM_LABEL]), false);
  for (const terminal of TERMINAL_LABELS) {
    assert.equal(violatesClaimInvariant([terminal]), false);
    assert.equal(violatesClaimInvariant(['feedback', terminal]), false);
  }
  assert.equal(violatesClaimInvariant(['feedback:new']), false);
  assert.equal(violatesClaimInvariant([]), false);
  assert.equal(violatesClaimInvariant(null), false);
});

test('violatesClaimInvariant: two terminal labels without the claim is not a claim-invariant violation', () => {
  // This helper guards the claim/terminal exclusion specifically; it does not
  // opine on terminal-vs-terminal combinations (those are the operator's go-gate).
  assert.equal(violatesClaimInvariant(TERMINAL_LABELS), false);
});

// --- (5) Stranded-claim reclaim time (safe recovery, no manual reset) ---------

test('reclaimAtIso: a stranded claim auto-reclaims at created_at + timeout', () => {
  const claim = { created_at: '2026-06-18T10:00:00.000Z' };
  // 2h after the claim was posted.
  assert.equal(reclaimAtIso(claim), '2026-06-18T12:00:00.000Z');
});

test('reclaimAtIso: honors an explicit timeout', () => {
  const claim = { created_at: '2026-06-18T10:00:00.000Z' };
  assert.equal(reclaimAtIso(claim, 60 * 60 * 1000), '2026-06-18T11:00:00.000Z'); // 1h
});

test('tolerates null/empty claim sets', () => {
  assert.equal(resolveOwner([], live), null);
  assert.equal(resolveOwner(null, live), null);
  assert.equal(resolveOwner([null], live), null);
});
