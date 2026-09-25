/**
 * systemone Op activities, resolved by the core activity registry when a
 * project's `chant.config.ts` lists the `systemone` lexicon:
 *
 *   - decide: ask a decision point (ws-058), calling the Jev-compatible
 *     backend its model decider names, and record the answer through core's
 *     `points ask` path.
 *
 * Every function exported here is registered as an activity by name, so
 * helpers stay in `./decide.ts` and are not re-exported.
 */
export { decide } from "./decide";
export type { DecideArgs, DecideResult } from "./decide";
