// Canonical, pure, unit-tested wave scheduler for cw-ship's build loop.
//
// `workflow.js` inlines a byte-for-byte mirror of `computeBuildWaves` because a
// Claude Code Workflow script (a) auto-runs its body on evaluation and (b) has
// no filesystem/module access at runtime, so it can neither be imported by a
// Node test nor import this module. This file is the tested source of truth;
// keep the mirror in workflow.js in sync. The function is pure: no Date.now(),
// no Math.random(), no argless `new Date()` (all forbidden in Workflow scripts).
//
// Unlike cw-orchestrate's scheduler, cw-ship's feedback issues carry NO declared
// logical dependencies on one another — each is an independent change. The only
// reason to serialize two of them is COLLISION: they would touch the same code.
// Two issues collide when their predicted paths overlap, OR when EITHER declares
// itself a `global_surface` change (a regen-from-shared-source edit — e.g. an
// OpenAPI spec regen, a formatter sweep, a generated-file bump — that always
// collides with everything because it rewrites a shared artifact). Predicted
// overlap is a scheduling OPTIMIZATION only — never load-bearing for correctness;
// the serial-merge gate in the build loop is the backstop that catches any
// collision the planner failed to predict.

/**
 * Compute collision-aware build waves for cw-ship.
 *
 * An (undirected) collision edge between issues A and B is added when:
 *   - A and B have overlapping predicted paths (`predicted_paths` share an
 *     entry), OR
 *   - either A or B declares `global_surface: true` (a shared-artifact regen
 *     always collides, so it serializes against every other build).
 *
 * Colliding issues are placed in different waves; mutually non-colliding issues
 * share a wave. Waves are built greedily by ascending issue number (Kahn-style
 * graph coloring against the already-placed set), and every wave is sorted
 * ascending, so the schedule is fully deterministic.
 *
 * All-disjoint input -> a single wave (full parallelism). All-colliding input
 * (or any `global_surface` issue) -> one issue per wave (today's fully-serial
 * behavior). Graceful degradation in both directions.
 *
 * @param {{issue:number, predicted_paths?:string[], global_surface?:boolean}[]} nodes
 * @returns {number[][]} ordered waves of issue numbers (each wave ascending)
 */
export function computeBuildWaves(nodes) {
  const ids = nodes.map((n) => n.issue).sort((a, b) => a - b);
  const byId = new Map(nodes.map((n) => [n.issue, n]));

  // Symmetric collision relation as a Set of "min-max" pair keys.
  const collides = new Set();
  const key = (a, b) => (a < b ? `${a}-${b}` : `${b}-${a}`);
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = ids[i];
      const b = ids[j];
      const na = byId.get(a);
      const nb = byId.get(b);
      const globalSurface = na.global_surface === true || nb.global_surface === true;
      const pa = na.predicted_paths || [];
      const pb = nb.predicted_paths || [];
      const overlaps = pa.some((p) => pb.includes(p));
      if (globalSurface || overlaps) collides.add(key(a, b));
    }
  }

  // Greedy graph coloring into waves, ascending issue number for determinism.
  // An issue joins the earliest wave containing no issue it collides with.
  const waves = [];
  for (const id of ids) {
    let placed = false;
    for (const wave of waves) {
      if (wave.some((other) => collides.has(key(id, other)))) continue;
      wave.push(id);
      placed = true;
      break;
    }
    if (!placed) waves.push([id]);
  }
  return waves.map((w) => [...w].sort((a, b) => a - b));
}
