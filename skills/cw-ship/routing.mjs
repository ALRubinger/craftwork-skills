// Canonical, pure, unit-tested model-routing dispatch for cw-ship.
//
// The Fable-pinned plan step judges each feedback issue against the shared
// complexity rubric (../cw-orchestrate/references/complexity-rubric.md) and
// emits a routing block { provider, model, effort, complexity, rationale }.
// This helper turns that block into the `agent()` opts for the build agent.
//
// `workflow.js` inlines a byte-for-byte mirror of `routedAgentOpts` because a
// Claude Code Workflow script (a) auto-runs its body on evaluation and (b) has
// no filesystem/module access at runtime, so it can neither be imported by a
// Node test nor import this module. This file is the tested source of truth;
// keep the mirror in workflow.js in sync (tests/mirror.test.mjs drift-guards
// it). Pure: no Date.now(), no Math.random(), no argless `new Date()`.

/**
 * Map a plan's routing block to Workflow `agent()` opts.
 *
 * v1 executes Claude tiers only: the routed model is honored only when
 * provider is "claude" and model is one of the four tiers `opts.model`
 * accepts. Anything else — a future non-Claude provider, a malformed block,
 * or no routing at all (e.g. a plan that yielded before routing) — defaults
 * UP to opus per the rubric's route-up bias. An invalid effort is dropped
 * (the harness default applies) rather than guessed.
 *
 * @param {{provider?:string, model?:string, effort?:string}|null|undefined} routing
 * @returns {{model:string, effort?:string}}
 */
export function routedAgentOpts(routing) {
  const r = routing || {};
  const models = ['fable', 'opus', 'sonnet', 'haiku'];
  const efforts = ['low', 'medium', 'high', 'xhigh', 'max'];
  if (r.provider !== 'claude' || !models.includes(r.model)) return { model: 'opus' };
  return efforts.includes(r.effort) ? { model: r.model, effort: r.effort } : { model: r.model };
}
