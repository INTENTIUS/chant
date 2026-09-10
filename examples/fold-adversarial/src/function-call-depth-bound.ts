import { ConfigMap } from "@intentius/chant-lexicon-k8s";

/**
 * Decision point: **L5.8 / F-Depth** — `MAX_FUNCTION_CALL_DEPTH = 32`
 * (`packages/core/src/fold/fold.ts`), the recursion bound on folding a call to
 * a project-local function.
 *
 * `nest` is admissible by every other rule: one expression for a body, one
 * plainly bound parameter, no `let`, no early return, no generator (L5.4). It
 * is also self-recursive, and folding a self-recursive call has no fixpoint
 * and no file boundary for fold-import's cycle detection to catch — so the
 * folder counts bodies instead and gives up at 32. `nest(40)` needs 41, so
 * this call is refused and the file falls back to run.
 *
 * A depth bound is a resource limit, not a semantic rule, which is precisely
 * why it belongs in a fold/run differential rather than only in `fold.test.ts`:
 * the bound is allowed to change what the fold path *attempts* and forbidden
 * to change what the build *produces*. Running has no such bound — 41 frames
 * is nothing — so the ConfigMap carries the full 40-deep string either way,
 * and the only observable difference is the `[fold:run]` line.
 *
 * The two other bounds in the same family are out of reach of a corpus fixture
 * of this size and are covered by unit tests instead:
 * `MAX_INTERPRETATION_DEPTH = 16` (L7.8) needs a self-referential composite
 * factory, and `MAX_RESOLUTION_DEPTH = 200` (L8.10) needs a 200-file import
 * chain.
 *
 * Differential mode: **byte-identical output**, with the file falling back to
 * run rather than folding.
 */
function nest(depth: number): string {
  return depth <= 0 ? "leaf" : `(${nest(depth - 1)})`;
}

export const depthBound = new ConfigMap({
  metadata: { name: "function-call-depth-bound" },
  data: {
    withinBound: nest(4),
    pastBound: nest(40),
  },
});
