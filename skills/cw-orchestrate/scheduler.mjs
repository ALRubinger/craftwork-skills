// Canonical, pure, unit-tested wave scheduler for cw-orchestrate.
//
// `workflow.js` inlines a byte-for-byte mirror of `computeWaves` because a
// Claude Code Workflow script (a) auto-runs its body on evaluation and (b) has
// no filesystem/module access at runtime, so it can neither be imported by a
// Node test nor import this module. This file is the tested source of truth;
// keep the mirror in workflow.js in sync. The function is pure: no Date.now(),
// no Math.random(), no argless `new Date()` (all forbidden in Workflow scripts).

/**
 * Compute dependency-aware execution waves.
 *
 * An edge A -> B (A must land before B) is added when:
 *   - B declares a logical dependency on A (`B.depends_on` includes A), or
 *   - A and B have overlapping ownership paths AND neither already has a
 *     logical edge to the other; the overlap edge is oriented lower-issue-first
 *     for determinism (file contention is symmetric, so the order is arbitrary
 *     but must be stable).
 *
 * Nodes are then topologically layered (Kahn): a wave is every remaining node
 * with no unplaced predecessor. Mutually independent nodes share a wave.
 *
 * @param {{issue:number, ownership_paths?:string[], depends_on?:number[]}[]} nodes
 * @returns {number[][]} ordered waves of issue numbers (each wave ascending)
 * @throws {Error} on an unknown dependency target or a dependency cycle
 */
export function computeWaves(nodes) {
  const ids = nodes.map((n) => n.issue).sort((a, b) => a - b);
  const byId = new Map(nodes.map((n) => [n.issue, n]));

  // Directed edges as a Set of "a->b" strings.
  const edges = new Set();
  const addEdge = (a, b) => {
    if (a !== b) edges.add(`${a}->${b}`);
  };

  // 1. Logical edges: a dependency must land before its dependent.
  for (const n of nodes) {
    for (const dep of n.depends_on || []) {
      if (!byId.has(dep)) {
        throw new Error(`#${n.issue} depends_on unknown issue #${dep}`);
      }
      addEdge(dep, n.issue);
    }
  }

  // 2. File-overlap edges, lower-issue-first, only when the pair is not
  //    already ordered by a logical edge (in either direction).
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = ids[i];
      const b = ids[j];
      const pa = byId.get(a).ownership_paths || [];
      const pb = byId.get(b).ownership_paths || [];
      const overlaps = pa.some((p) => pb.includes(p));
      if (!overlaps) continue;
      if (edges.has(`${a}->${b}`) || edges.has(`${b}->${a}`)) continue;
      addEdge(a, b);
    }
  }

  // 3. Kahn layering into waves.
  const remaining = new Set(ids);
  const inDegreeWithin = (id) => {
    let count = 0;
    for (const e of edges) {
      const [src, dst] = e.split('->').map(Number);
      if (dst === id && remaining.has(src)) count++;
    }
    return count;
  };

  const waves = [];
  while (remaining.size > 0) {
    const wave = [...remaining]
      .filter((id) => inDegreeWithin(id) === 0)
      .sort((a, b) => a - b);
    if (wave.length === 0) {
      const stuck = [...remaining].sort((a, b) => a - b).join(', ');
      throw new Error(`dependency cycle detected among: ${stuck}`);
    }
    for (const id of wave) remaining.delete(id);
    waves.push(wave);
  }
  return waves;
}

/**
 * Nodes eligible to advance given a set of already-MERGED issues.
 *
 * Same edge model as `computeWaves` (logical `depends_on` ∪ file-overlap,
 * lower-issue-first), but instead of layering the whole graph up front it answers
 * a runtime question: which not-yet-merged nodes have ALL their predecessors
 * already merged? Those — and only those — may fire their plan→work→merge chain
 * right now; everything else waits for a predecessor to land.
 *
 * This is what makes execution per-node rather than per-barrier: a node fires the
 * instant its own predecessors merge, regardless of slow unrelated siblings.
 *
 * The plan gate calls this with ownership_paths stripped (file-overlap is a
 * merge-contention concern, not a plan-correctness one, and a dependent's paths
 * aren't known until it is planned), so only `depends_on` edges apply; the
 * work/merge gate calls it with the planned nodes' real ownership_paths so the
 * full edge model applies. The function itself is agnostic to which.
 *
 * @param {{issue:number, ownership_paths?:string[], depends_on?:number[]}[]} nodes
 * @param {Iterable<number>} merged issue numbers already merged onto the target
 * @returns {number[]} not-yet-merged issues whose every predecessor is merged (ascending)
 */
export function eligible(nodes, merged) {
  const mergedSet = new Set(merged);
  const ids = nodes.map((n) => n.issue).sort((a, b) => a - b);
  const byId = new Map(nodes.map((n) => [n.issue, n]));

  // Directed edges as a Set of "a->b" strings (a must land before b).
  const edges = new Set();
  const addEdge = (a, b) => {
    if (a !== b) edges.add(`${a}->${b}`);
  };
  for (const n of nodes) {
    for (const dep of n.depends_on || []) {
      if (byId.has(dep)) addEdge(dep, n.issue);
    }
  }
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = ids[i];
      const b = ids[j];
      const pa = byId.get(a).ownership_paths || [];
      const pb = byId.get(b).ownership_paths || [];
      if (!pa.some((p) => pb.includes(p))) continue;
      if (edges.has(`${a}->${b}`) || edges.has(`${b}->${a}`)) continue;
      addEdge(a, b);
    }
  }

  // A node is eligible iff it is not already merged and every predecessor is.
  const predecessorsMerged = (id) => {
    for (const e of edges) {
      const [src, dst] = e.split('->').map(Number);
      if (dst === id && !mergedSet.has(src)) return false;
    }
    return true;
  };
  return ids.filter((id) => !mergedSet.has(id) && predecessorsMerged(id));
}

/**
 * Transitive dependents of a set of halted issues, over the same edge model the
 * scheduler uses (logical ∪ file-overlap). Used by the failure cascade: a
 * halted/stalled node halts everything reachable from it.
 *
 * @param {{issue:number, ownership_paths?:string[], depends_on?:number[]}[]} nodes
 * @param {number[]} halted seed set of halted issue numbers
 * @returns {Set<number>} halted seeds plus all transitive dependents
 */
export function transitiveDependents(nodes, halted) {
  const ids = nodes.map((n) => n.issue).sort((a, b) => a - b);
  const byId = new Map(nodes.map((n) => [n.issue, n]));
  const edges = new Set();
  const addEdge = (a, b) => {
    if (a !== b) edges.add(`${a}->${b}`);
  };
  for (const n of nodes) {
    for (const dep of n.depends_on || []) {
      if (byId.has(dep)) addEdge(dep, n.issue);
    }
  }
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = ids[i];
      const b = ids[j];
      const pa = byId.get(a).ownership_paths || [];
      const pb = byId.get(b).ownership_paths || [];
      if (!pa.some((p) => pb.includes(p))) continue;
      if (edges.has(`${a}->${b}`) || edges.has(`${b}->${a}`)) continue;
      addEdge(a, b);
    }
  }

  const out = new Set(halted);
  const queue = [...halted];
  while (queue.length > 0) {
    const cur = queue.shift();
    for (const e of edges) {
      const [src, dst] = e.split('->').map(Number);
      if (src === cur && !out.has(dst)) {
        out.add(dst);
        queue.push(dst);
      }
    }
  }
  return out;
}
