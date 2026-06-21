// Tests for cw-ship's pure build-wave scheduler. Run: `node --test tests/`
// Contract tested: collision edges from predicted-path overlap ∪ global_surface,
// greedy ascending coloring into waves, and the two graceful-degradation extremes
// (all-disjoint -> one parallel wave; all-colliding -> fully serial).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeBuildWaves } from '../schedule.mjs';

// All-disjoint: no shared predicted paths, no global surface -> one parallel wave.
test('fully independent issues share one wave', () => {
  const nodes = [
    { issue: 1, predicted_paths: ['a.js'], global_surface: false },
    { issue: 2, predicted_paths: ['b.js'], global_surface: false },
    { issue: 3, predicted_paths: ['c.js'], global_surface: false },
  ];
  assert.deepEqual(computeBuildWaves(nodes), [[1, 2, 3]]);
});

// Two issues sharing a predicted path collide and serialize into different waves,
// lower-issue-first.
test('predicted-path overlap serializes into different waves', () => {
  const nodes = [
    { issue: 10, predicted_paths: ['skills/cw-ship/workflow.js'], global_surface: false },
    { issue: 20, predicted_paths: ['skills/cw-ship/workflow.js'], global_surface: false },
  ];
  assert.deepEqual(computeBuildWaves(nodes), [[10], [20]]);
});

// A global_surface issue collides with everything (regen-from-shared-source),
// so it never shares a wave with another build even with disjoint paths.
test('global_surface issue serializes against every other build', () => {
  const nodes = [
    { issue: 5, predicted_paths: ['a.js'], global_surface: false },
    { issue: 6, predicted_paths: ['b.js'], global_surface: true }, // regen sweep
    { issue: 7, predicted_paths: ['c.js'], global_surface: false },
  ];
  const waves = computeBuildWaves(nodes);
  // 5 and 7 are disjoint and share wave 1; 6 collides with both -> its own wave.
  assert.deepEqual(waves[0], [5, 7]);
  assert.deepEqual(waves[1], [6]);
  assert.equal(waves.length, 2);
});

// All-colliding (everyone touches the same path) -> fully serial, one per wave:
// today's behavior, recovered as the limiting case.
test('all-overlapping degrades to fully serial', () => {
  const nodes = [
    { issue: 1, predicted_paths: ['shared.js'] },
    { issue: 2, predicted_paths: ['shared.js'] },
    { issue: 3, predicted_paths: ['shared.js'] },
  ];
  assert.deepEqual(computeBuildWaves(nodes), [[1], [2], [3]]);
});

// Mixed: a colliding pair plus an independent issue. The independent one packs
// into the first available wave alongside a non-colliding member.
test('mixed collisions pack greedily by ascending issue number', () => {
  const nodes = [
    { issue: 1, predicted_paths: ['shared.js'] },
    { issue: 2, predicted_paths: ['shared.js'] }, // collides with 1
    { issue: 3, predicted_paths: ['solo.js'] }, // independent
  ];
  const waves = computeBuildWaves(nodes);
  // 1 -> wave1; 2 collides with 1 -> wave2; 3 collides with neither -> joins wave1.
  assert.deepEqual(waves[0], [1, 3]);
  assert.deepEqual(waves[1], [2]);
});

// Missing predicted_paths (planner emitted nothing) is treated as "unknown, no
// predicted overlap": such an issue runs in parallel. The serial-merge gate is
// the backstop if it actually collides — prediction is an optimization only.
test('missing predicted_paths defaults to no-overlap (parallel)', () => {
  const nodes = [
    { issue: 1 }, // no predicted_paths, no global_surface
    { issue: 2, predicted_paths: ['x.js'] },
  ];
  assert.deepEqual(computeBuildWaves(nodes), [[1, 2]]);
});

// Empty input yields no waves.
test('empty input yields no waves', () => {
  assert.deepEqual(computeBuildWaves([]), []);
});

// A single issue is one wave of one.
test('single issue is one wave', () => {
  assert.deepEqual(computeBuildWaves([{ issue: 42, predicted_paths: ['a.js'] }]), [[42]]);
});

// Determinism: input order does not change the result (sorted internally).
test('result is independent of input order', () => {
  const a = computeBuildWaves([
    { issue: 3, predicted_paths: ['shared.js'] },
    { issue: 1, predicted_paths: ['shared.js'] },
    { issue: 2, predicted_paths: ['solo.js'] },
  ]);
  const b = computeBuildWaves([
    { issue: 1, predicted_paths: ['shared.js'] },
    { issue: 2, predicted_paths: ['solo.js'] },
    { issue: 3, predicted_paths: ['shared.js'] },
  ]);
  assert.deepEqual(a, b);
  // 1 -> wave1; 2 disjoint -> wave1; 3 collides with 1 -> wave2.
  assert.deepEqual(a, [[1, 2], [3]]);
});
