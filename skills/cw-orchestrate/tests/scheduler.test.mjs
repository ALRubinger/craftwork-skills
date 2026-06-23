// Tests for the pure wave scheduler. Run: `node --test tests/`
// Contract tested: edges from declared deps ∪ file-overlap, Kahn layering into
// ascending waves, cycle rejection, and the failure cascade's transitive set.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeWaves, eligible, transitiveDependents } from '../scheduler.mjs';

// AE2: two issues sharing an ownership path land in different waves even with
// no declared logical dependency.
test('file-overlap with no declared dep serializes into different waves', () => {
  const nodes = [
    { issue: 10, ownership_paths: ['cmd/vault.go'], depends_on: [] },
    { issue: 20, ownership_paths: ['cmd/vault.go'], depends_on: [] },
  ];
  const waves = computeWaves(nodes);
  assert.deepEqual(waves, [[10], [20]]); // lower-issue-first, serialized
});

// A declared-dep chain orders the dependency before the dependent.
test('declared dependency orders dep before dependent', () => {
  const nodes = [
    { issue: 984, ownership_paths: ['a.go'], depends_on: [981] },
    { issue: 981, ownership_paths: ['b.go'], depends_on: [] },
  ];
  const waves = computeWaves(nodes);
  assert.deepEqual(waves, [[981], [984]]);
});

// Fully independent issues (no deps, no overlap) all share wave 1.
test('fully independent issues share one wave', () => {
  const nodes = [
    { issue: 1, ownership_paths: ['x.go'], depends_on: [] },
    { issue: 2, ownership_paths: ['y.go'], depends_on: [] },
    { issue: 3, ownership_paths: ['z.go'], depends_on: [] },
  ];
  assert.deepEqual(computeWaves(nodes), [[1, 2, 3]]);
});

// A declared cycle is rejected, not silently mis-scheduled (U3/U6 invariant).
test('dependency cycle is rejected', () => {
  const nodes = [
    { issue: 1, ownership_paths: [], depends_on: [2] },
    { issue: 2, ownership_paths: [], depends_on: [1] },
  ];
  assert.throws(() => computeWaves(nodes), /cycle detected among: 1, 2/);
});

// An unknown dependency target is rejected.
test('unknown dependency target is rejected', () => {
  const nodes = [{ issue: 1, ownership_paths: [], depends_on: [999] }];
  assert.throws(() => computeWaves(nodes), /unknown issue #999/);
});

// AE6: a realistic umbrella shape. #984/#985/#986 each declare a logical dep on
// #981 (so they follow it) but do NOT overlap one another in this fixture, so
// they share wave 2. The independents (incl. the linchpin #981) fill wave 1.
test('AE6: #989 shape yields the documented waves', () => {
  const nodes = [
    // Wave 1 — independents + the linchpin #981.
    { issue: 980, ownership_paths: ['internal/server/shutdown.go'], depends_on: [] },
    { issue: 981, ownership_paths: ['cmd/items.go', 'internal/api/openapi.yaml'], depends_on: [] },
    { issue: 982, ownership_paths: ['internal/server/authspec.go'], depends_on: [] },
    { issue: 983, ownership_paths: ['internal/server/launch.go'], depends_on: [] },
    { issue: 987, ownership_paths: ['internal/server/env.go'], depends_on: [] },
    { issue: 988, ownership_paths: ['test/mount_test.go'], depends_on: [] },
    // Wave 2 — depend on #981, no mutual overlap among themselves.
    { issue: 984, ownership_paths: ['internal/server/freshness.go'], depends_on: [981] },
    { issue: 985, ownership_paths: ['internal/audit/events.go'], depends_on: [981] },
    { issue: 986, ownership_paths: ['cmd/import.go'], depends_on: [981] },
  ];
  const waves = computeWaves(nodes);
  assert.equal(waves.length, 2, 'expected exactly two waves');
  assert.deepEqual(waves[0], [980, 981, 982, 983, 987, 988]);
  assert.deepEqual(waves[1], [984, 985, 986]);
});

// "Intra-wave parallelism decided by whether their ownership tables overlap":
// if two wave-2 dependents DO overlap each other, they split into sub-waves.
test('mutual overlap among dependents splits them across waves', () => {
  const nodes = [
    { issue: 981, ownership_paths: ['cmd/vault.go'], depends_on: [] },
    { issue: 984, ownership_paths: ['shared.go'], depends_on: [981] },
    { issue: 985, ownership_paths: ['shared.go'], depends_on: [981] },
    { issue: 986, ownership_paths: ['solo.go'], depends_on: [981] },
  ];
  const waves = computeWaves(nodes);
  // 981 first; then 984 & 986 (no mutual overlap) share a wave; 985 follows 984.
  assert.deepEqual(waves[0], [981]);
  assert.deepEqual(waves[1], [984, 986]);
  assert.deepEqual(waves[2], [985]);
});

// Failure cascade: a halted linchpin halts its transitive dependents only.
test('transitiveDependents halts the linchpin subtree, not independents', () => {
  const nodes = [
    { issue: 980, ownership_paths: ['a.go'], depends_on: [] },
    { issue: 981, ownership_paths: ['vault.go'], depends_on: [] },
    { issue: 984, ownership_paths: ['x.go'], depends_on: [981] },
    { issue: 985, ownership_paths: ['y.go'], depends_on: [981] },
    { issue: 986, ownership_paths: ['z.go'], depends_on: [984] }, // transitive
  ];
  const halted = transitiveDependents(nodes, [981]);
  assert.deepEqual([...halted].sort((a, b) => a - b), [981, 984, 985, 986]);
  assert.ok(!halted.has(980), '#980 is independent and must not be halted');
});

// ---------------------------------------------------------------------------
// eligible(nodes, merged): per-node firing. This is what makes the run plan +
// work each node the instant ITS predecessors merge, instead of planning the
// whole graph up front behind a barrier. Same edge model as computeWaves.
// ---------------------------------------------------------------------------

// A dependent is NOT eligible until its declared-dep predecessor has MERGED.
// This is the core fix: a same-run dependent must defer (plan included) until its
// prerequisite has landed on the target, so it plans against the merged output.
test('eligible: a dependent is withheld until its depends_on predecessor has merged', () => {
  const nodes = [
    { issue: 981, ownership_paths: ['b.go'], depends_on: [] },
    { issue: 984, ownership_paths: ['a.go'], depends_on: [981] },
  ];
  // Nothing merged: only the predecessor #981 may fire; #984 is gated.
  assert.deepEqual(eligible(nodes, []), [981]);
  assert.ok(!eligible(nodes, []).includes(984), '#984 must not fire before #981 merges');
  // #981 merged: now #984 becomes eligible; the merged #981 is excluded.
  assert.deepEqual(eligible(nodes, [981]), [984]);
});

// Per-node, NOT per-barrier: an independent node is not blocked by a slow,
// unrelated sibling that happens to sit in an earlier topological layer. Under
// the old wave model, #986 would wait for the whole of wave 1 (incl. the slow
// linchpin #981) to merge; under per-node gating it fires immediately.
test('eligible: an independent node is not blocked by an unrelated slow sibling', () => {
  const nodes = [
    // #981 is a slow linchpin with dependents; #986 is fully independent of it.
    { issue: 981, ownership_paths: ['cmd/items.go'], depends_on: [] },
    { issue: 984, ownership_paths: ['x.go'], depends_on: [981] },
    { issue: 986, ownership_paths: ['solo.go'], depends_on: [] },
  ];
  const e = eligible(nodes, []);
  assert.ok(e.includes(986), '#986 is independent and must fire without waiting on #981');
  assert.ok(e.includes(981), '#981 (no predecessors) is also eligible');
  assert.ok(!e.includes(984), '#984 depends on #981 and must wait');
});

// File-overlap with no declared dep still serializes: the lower-issue node fires
// first; its overlapping sibling waits for it to merge (the same contention edge
// computeWaves draws).
test('eligible: file-overlap predecessor (no declared dep) gates the higher-issue sibling', () => {
  const nodes = [
    { issue: 10, ownership_paths: ['cmd/vault.go'], depends_on: [] },
    { issue: 20, ownership_paths: ['cmd/vault.go'], depends_on: [] },
  ];
  assert.deepEqual(eligible(nodes, []), [10]); // lower-issue-first
  assert.deepEqual(eligible(nodes, [10]), [20]); // 20 unblocks once 10 merges
});

// Already-merged nodes are never re-emitted as eligible.
test('eligible: merged nodes are excluded from the eligible set', () => {
  const nodes = [
    { issue: 1, ownership_paths: ['x.go'], depends_on: [] },
    { issue: 2, ownership_paths: ['y.go'], depends_on: [] },
  ];
  assert.deepEqual(eligible(nodes, [1, 2]), []);
  assert.deepEqual(eligible(nodes, [1]), [2]);
});

// Stripping ownership_paths reduces the gate to declared deps only — exactly how
// the PLAN gate is invoked (file-overlap is a merge-contention concern, not a
// plan-correctness one, so two file-overlapping nodes may PLAN concurrently).
test('eligible: with paths stripped, only declared deps gate (the plan gate)', () => {
  const nodes = [
    { issue: 10, ownership_paths: [], depends_on: [] },
    { issue: 20, ownership_paths: [], depends_on: [] }, // would overlap #10 if paths present
  ];
  // No file-overlap edge ⇒ both plan-eligible together (no barrier between them).
  assert.deepEqual(eligible(nodes, []), [10, 20]);
});
