// Canonical claim-resolution contract for cw-ship's per-issue concurrency guard.
//
// Multiple cw-ship runs can process the same repo concurrently. The per-issue
// CLAIM — not any repo-level lock — is the sole mutual-exclusion primitive: a run
// may build an issue only if it owns the issue's claim. A claim is a GitHub
// comment carrying the marker `<!-- cw-ship/claim -->`; GitHub assigns it an
// immutable `id` and `created_at`, which are the claim's identity and tiebreak.
// Nothing here depends on a shell PID or a process being alive — the Claude Code
// harness runs every Bash call in a fresh ephemeral shell, so process-liveness is
// meaningless and the old `$$`-in-a-lockfile scheme was unsound by construction.
//
// These pure functions are the TESTED SPECIFICATION of the rule; `planPrompt` in
// workflow.js implements the same rule via gh. Keep the two in sync — claim.test.mjs
// pins the behavior. No Date.now()/Math.random()/argless `new Date()` (forbidden in
// Workflow scripts): callers pass `nowMs`, and `Date.parse` of an explicit string is
// deterministic.

export const CLAIM_MARKER = '<!-- cw-ship/claim -->';
// A claim older than this with no live work is a crashed run's claim — reclaimable.
export const CLAIM_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2 hours

// The in-flight claim label and the terminal-state labels are MUTUALLY EXCLUSIVE:
// `feedback:triaging` means a run holds the issue; the terminal labels mean the run
// released it (parked for input, cleared to go, or closed). An issue must never
// carry both at once. The both-labels state the operator hit (an issue carrying
// feedback:triaging AND feedback:needs-input) is exactly this invariant violated.
export const CLAIM_LABEL = 'feedback:triaging';
export const TERMINAL_LABELS = ['feedback:needs-input', 'feedback:go'];

const epoch = (iso) => Date.parse(iso);

/**
 * Does a label set violate the claim-vs-terminal invariant — i.e. does it carry
 * the in-flight claim label AND any terminal-state label at the same time? Every
 * step that reaches a terminal route (park, go, umbrella, merge) must remove the
 * claim label in the same transition so this never holds. A reclaim/reset that
 * adds the claim label must remove the terminal labels for the same reason.
 * @param {string[]} labels  label NAMES present on the issue
 * @returns {boolean}
 */
export function violatesClaimInvariant(labels) {
  const set = new Set(labels || []);
  if (!set.has(CLAIM_LABEL)) return false;
  return TERMINAL_LABELS.some((t) => set.has(t));
}

/**
 * Is one claim crashed/stale? Stale iff it is older than the timeout AND the
 * issue shows no live work (no open PR referencing it) AND the issue itself has
 * not been updated within the timeout. Liveness is judged by work artifacts +
 * recency, never by a process being alive.
 * @param {{created_at: string}} claim
 * @param {{nowMs: number, hasOpenPR: boolean, issueUpdatedAt: string, timeoutMs?: number}} ctx
 * @returns {boolean}
 */
export function isClaimStale(claim, ctx) {
  const timeoutMs = ctx.timeoutMs ?? CLAIM_TIMEOUT_MS;
  if (ctx.hasOpenPR) return false; // an open PR means the run's work is live
  const olderThanTimeout = ctx.nowMs - epoch(claim.created_at) > timeoutMs;
  const issueIdle = ctx.nowMs - epoch(ctx.issueUpdatedAt) > timeoutMs;
  return olderThanTimeout && issueIdle;
}

/**
 * The owning claim: the earliest NON-stale claim — earliest `created_at`, ties
 * broken by the lowest numeric `id`. Returns null when there is no live claim
 * (none posted, or every claim is crashed/stale → the issue is reclaimable).
 * @param {Array<{id: number|string, created_at: string}>} claims
 * @param {object} ctx  see isClaimStale
 * @returns {{id: number|string, created_at: string} | null}
 */
export function resolveOwner(claims, ctx) {
  const live = (claims || []).filter((c) => c && !isClaimStale(c, ctx));
  if (live.length === 0) return null;
  return live.reduce((best, c) => {
    const bt = epoch(best.created_at);
    const ct = epoch(c.created_at);
    if (ct < bt) return c;
    if (ct === bt && Number(c.id) < Number(best.id)) return c;
    return best;
  });
}

/**
 * Does claim `myId` own the issue, given the full claim set? A run proceeds to
 * build only when this is true; otherwise it yields.
 * @param {number|string} myId
 */
export function ownsClaim(myId, claims, ctx) {
  const owner = resolveOwner(claims, ctx);
  return owner != null && Number(owner.id) === Number(myId);
}

/**
 * Is a `feedback:triaging` issue reclaimable — its prior claim crashed, so a new
 * run may take it? True iff no live claim exists. Discovery includes
 * feedback:new / feedback:go always, and feedback:triaging ONLY when this is true
 * (an in-flight, live claim is excluded so the owning run is never disturbed).
 */
export function isReclaimable(claims, ctx) {
  return resolveOwner(claims, ctx) === null;
}

/**
 * When does a still-live claim age out into reclaimable territory? A claim is only
 * reclaimable once it is past the age threshold AND the issue shows no live work,
 * so the earliest a stranded claim can be auto-reclaimed is its `created_at` plus
 * the timeout. The report surfaces this instant so the operator waits for the loop
 * to self-heal instead of manually resetting `feedback:triaging -> feedback:new`
 * and racing a live orphan. Returns an ISO-8601 string.
 * @param {{created_at: string}} claim  the owning (live) claim
 * @param {number} [timeoutMs]
 * @returns {string}
 */
export function reclaimAtIso(claim, timeoutMs = CLAIM_TIMEOUT_MS) {
  return new Date(epoch(claim.created_at) + timeoutMs).toISOString();
}
