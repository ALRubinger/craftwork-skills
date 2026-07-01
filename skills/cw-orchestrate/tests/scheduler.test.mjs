// Tests for the pure wave scheduler. Run: `node --test tests/`
// Contract tested: edges from declared deps ∪ file-overlap, Kahn layering into
// ascending waves, cycle rejection, and the failure cascade's transitive set.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeWaves,
  eligible,
  transitiveDependents,
  pickReadyUmbrellas,
  readyLabelTerminalAction,
  needsInputTerminalAction,
  PARKED_SUBISSUE_LABEL,
} from '../scheduler.mjs';

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

// ---------------------------------------------------------------------------
// pickReadyUmbrellas(issues, label): the repo-scan pickup enumerator. Returns
// ascending numbers of OPEN issues carrying the pickup label. Main-session-only
// (runs via gh), so not mirrored in workflow.js.
// ---------------------------------------------------------------------------

// Acceptance: a mixed repo-scan fixture yields only the OPEN labeled numbers,
// ascending. A closed-but-still-labeled umbrella is excluded (its terminal
// transition would strip the label; a closed umbrella is never re-picked).
test('pickReadyUmbrellas: returns only OPEN labeled umbrellas, ascending', () => {
  const issues = [
    { number: 30, state: 'OPEN', labels: [{ name: 'cw-umbrella:ready' }] },
    { number: 10, state: 'OPEN', labels: [{ name: 'cw-umbrella:ready' }, { name: 'x' }] },
    { number: 20, state: 'OPEN', labels: [{ name: 'other' }] }, // open, unlabeled
    { number: 40, state: 'CLOSED', labels: [{ name: 'cw-umbrella:ready' }] }, // closed+labeled
  ];
  assert.deepEqual(pickReadyUmbrellas(issues), [10, 30]);
});

// Label shapes: [{name}] objects and bare [string] names both resolve; lowercase
// `state` (REST form) is tolerated alongside the uppercase gh --json form.
test('pickReadyUmbrellas: tolerates string-label and lowercase-state shapes', () => {
  const issues = [
    { number: 5, state: 'open', labels: ['cw-umbrella:ready'] },
    { number: 6, state: 'open', labels: ['nope'] },
    { number: 7, state: 'closed', labels: ['cw-umbrella:ready'] },
  ];
  assert.deepEqual(pickReadyUmbrellas(issues), [5]);
});

// Edge cases: empty input and label-absent-everywhere both yield [].
test('pickReadyUmbrellas: empty input and label-absent yield []', () => {
  assert.deepEqual(pickReadyUmbrellas([]), []);
  assert.deepEqual(pickReadyUmbrellas(undefined), []);
  assert.deepEqual(
    pickReadyUmbrellas([{ number: 1, state: 'OPEN', labels: [{ name: 'a' }] }]),
    [],
  );
});

// A custom label name is honored (default is cw-umbrella:ready).
test('pickReadyUmbrellas: respects a custom label argument', () => {
  const issues = [
    { number: 1, state: 'OPEN', labels: ['ship:ready'] },
    { number: 2, state: 'OPEN', labels: ['cw-umbrella:ready'] },
  ];
  assert.deepEqual(pickReadyUmbrellas(issues, 'ship:ready'), [1]);
});

// ---------------------------------------------------------------------------
// readyLabelTerminalAction(umbrella): the terminal-transition decision. 'remove'
// when the umbrella is fully resolved (closed, or every sub-issue closed); 'keep'
// while it still tracks work. Drives in-band label removal in Step 7.
// ---------------------------------------------------------------------------

// A fully-resolved umbrella (all sub-issues closed) → 'remove'.
test('readyLabelTerminalAction: all sub-issues closed → remove', () => {
  const umbrella = {
    state: 'OPEN',
    subIssues: [{ state: 'CLOSED' }, { state: 'CLOSED' }],
  };
  assert.equal(readyLabelTerminalAction(umbrella), 'remove');
});

// A partially-resolved umbrella (one open sub-issue) → 'keep' (a later scan may
// retry; the label persists through an in-flight/crashed run).
test('readyLabelTerminalAction: a still-open sub-issue → keep', () => {
  const umbrella = {
    state: 'OPEN',
    subIssues: [{ state: 'CLOSED' }, { state: 'OPEN' }],
  };
  assert.equal(readyLabelTerminalAction(umbrella), 'keep');
});

// A closed umbrella → 'remove' regardless of sub-issue state (it is done).
test('readyLabelTerminalAction: a closed umbrella → remove', () => {
  assert.equal(
    readyLabelTerminalAction({ state: 'CLOSED', subIssues: [{ state: 'OPEN' }] }),
    'remove',
  );
});

// An umbrella with no sub-issues yet → 'keep' (nothing has resolved).
test('readyLabelTerminalAction: no sub-issues → keep; null → keep', () => {
  assert.equal(readyLabelTerminalAction({ state: 'OPEN', subIssues: [] }), 'keep');
  assert.equal(readyLabelTerminalAction({ state: 'OPEN' }), 'keep');
  assert.equal(readyLabelTerminalAction(null), 'keep');
});

// Compose the two: after a fully-resolved umbrella's terminal action fires
// ('remove') and the label is stripped from the fixture, a re-scan does NOT
// re-pick it — proving idempotent, no-double-run terminal behavior.
test('terminal removal makes a re-scan skip the resolved umbrella', () => {
  const label = 'cw-umbrella:ready';
  const resolved = {
    number: 50,
    state: 'OPEN',
    labels: [{ name: label }],
    subIssues: [{ state: 'CLOSED' }],
  };
  const stillWorking = {
    number: 51,
    state: 'OPEN',
    labels: [{ name: label }],
    subIssues: [{ state: 'OPEN' }],
  };
  const repo = [resolved, stillWorking];
  // First scan picks both.
  assert.deepEqual(pickReadyUmbrellas(repo), [50, 51]);
  // #50 is fully resolved → remove its label; #51 keeps tracking → keep.
  assert.equal(readyLabelTerminalAction(resolved), 'remove');
  assert.equal(readyLabelTerminalAction(stillWorking), 'keep');
  // Simulate the terminal removal on the live fixture.
  resolved.labels = resolved.labels.filter((l) => l.name !== label);
  // Re-scan: #50 is no longer re-picked; #51 remains until it too resolves.
  assert.deepEqual(pickReadyUmbrellas(repo), [51]);
});

// ---------------------------------------------------------------------------
// Parked-umbrella state: readyLabelTerminalAction 'park' + needsInputTerminalAction.
// When an OPEN umbrella's only remaining open work is parked sub-issues
// (PARKED_SUBISSUE_LABEL), the ready label is swapped to cw-umbrella:needs-input
// so scans stop churning; the reverse fires once a park clears.
// ---------------------------------------------------------------------------

// Every open sub-issue parked → 'park' (swap :ready → :needs-input), NOT 'keep'
// (which would leave the umbrella in the scan set and re-run every tick).
test('readyLabelTerminalAction: all open sub-issues parked → park', () => {
  const umbrella = {
    state: 'OPEN',
    subIssues: [
      { state: 'CLOSED' },
      { state: 'OPEN', labels: [{ name: PARKED_SUBISSUE_LABEL }] },
    ],
  };
  assert.equal(readyLabelTerminalAction(umbrella), 'park');
});

// A mix of parked and runnable open work → 'keep' (there is still something a
// run can advance; do not retire :ready).
test('readyLabelTerminalAction: one runnable open sub-issue among parked → keep', () => {
  const umbrella = {
    state: 'OPEN',
    subIssues: [
      { state: 'OPEN', labels: [{ name: PARKED_SUBISSUE_LABEL }] },
      { state: 'OPEN', labels: [] },
    ],
  };
  assert.equal(readyLabelTerminalAction(umbrella), 'keep');
});

// A parked umbrella is skipped by a :ready scan once swapped to :needs-input,
// and needsInputTerminalAction 'hold's it while still all-parked.
test('parked umbrella leaves the :ready scan set and holds under :needs-input', () => {
  const ready = 'cw-umbrella:ready';
  const needsInput = 'cw-umbrella:needs-input';
  const umbrella = {
    number: 60,
    state: 'OPEN',
    labels: [{ name: ready }],
    subIssues: [{ state: 'OPEN', labels: [{ name: PARKED_SUBISSUE_LABEL }] }],
  };
  // Scan picks it; terminal action says park.
  assert.deepEqual(pickReadyUmbrellas([umbrella]), [60]);
  assert.equal(readyLabelTerminalAction(umbrella), 'park');
  // Simulate the swap :ready → :needs-input.
  umbrella.labels = [{ name: needsInput }];
  // A :ready scan no longer re-picks it — churn stopped.
  assert.deepEqual(pickReadyUmbrellas([umbrella]), []);
  // Still all-parked → hold under the needs-input state.
  assert.equal(needsInputTerminalAction(umbrella), 'hold');
});

// The reverse transition: once a park clears (the sub-issue loses
// PARKED_SUBISSUE_LABEL), needsInputTerminalAction → 'restore' so the caller
// swaps :needs-input → :ready and the next scan re-picks it.
test('needsInputTerminalAction: a cleared park → restore', () => {
  const umbrella = {
    state: 'OPEN',
    subIssues: [{ state: 'OPEN', labels: [] }],
  };
  assert.equal(needsInputTerminalAction(umbrella), 'restore');
});

// A needs-input umbrella whose parked work all closed out → 'remove' (fully
// resolved; strip the needs-input label, nothing to re-pick).
test('needsInputTerminalAction: all sub-issues closed → remove; closed umbrella → remove', () => {
  assert.equal(
    needsInputTerminalAction({ state: 'OPEN', subIssues: [{ state: 'CLOSED' }] }),
    'remove',
  );
  assert.equal(
    needsInputTerminalAction({ state: 'CLOSED', subIssues: [{ state: 'OPEN' }] }),
    'remove',
  );
});

// Null/edge: no umbrella → 'hold' (safe default; nothing to transition).
test('needsInputTerminalAction: null → hold', () => {
  assert.equal(needsInputTerminalAction(null), 'hold');
});
