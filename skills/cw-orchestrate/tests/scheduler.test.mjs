// Tests for the pure wave scheduler. Run: `node --test tests/`
// Contract tested: edges from declared deps ∪ file-overlap, Kahn layering into
// ascending waves, cycle rejection, and the failure cascade's transitive set.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeWaves, transitiveDependents } from '../scheduler.mjs';

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

// AE6: the #989 agent-auth shape. #984/#985/#986 declare a logical dep on #981
// and share the vault area with #981 (so they follow it), but do NOT overlap
// one another in this fixture, so they share wave 2. Independents fill wave 1.
test('AE6: #989 shape yields the documented waves', () => {
  const nodes = [
    // Wave 1 — independents + the linchpin #981.
    { issue: 980, ownership_paths: ['internal/agent/shutdown.go'], depends_on: [] },
    { issue: 981, ownership_paths: ['cmd/aileron/vault.go', 'internal/api/openapi.yaml'], depends_on: [] },
    { issue: 982, ownership_paths: ['internal/agent/authspec_goose.go'], depends_on: [] },
    { issue: 983, ownership_paths: ['internal/agent/host_launch.go'], depends_on: [] },
    { issue: 987, ownership_paths: ['internal/agent/claude_env.go'], depends_on: [] },
    { issue: 988, ownership_paths: ['test/bindmount_test.go'], depends_on: [] },
    // Wave 2 — depend on #981, no mutual overlap among themselves.
    { issue: 984, ownership_paths: ['internal/agent/freshness.go'], depends_on: [981] },
    { issue: 985, ownership_paths: ['internal/audit/vault_events.go'], depends_on: [981] },
    { issue: 986, ownership_paths: ['cmd/aileron/auth_import.go'], depends_on: [981] },
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
