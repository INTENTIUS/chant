/**
 * cedar Op activities — resolved by the core activity registry when a
 * project's `chant.config.ts` lists the `cedar` lexicon.
 *
 * The registry keys every exported *function* in this module by its name
 * (`loadActivities` → `collectActivities`), which is why only the activities
 * themselves are exported here. `dogwoodReplay`'s helpers — the input
 * resolver, the verdict comparison, the summary renderer — stay importable
 * from `@intentius/chant-lexicon-cedar/dogwood/replay-activity` rather than
 * being registered as activities nobody would ever name in a step.
 *
 * Contributed the `flyApply` way: a plain async function taking one args
 * object, with no Temporal import anywhere beneath it, so the local executor
 * runs it unchanged and a Temporal worker registers the same function.
 */

export { dogwoodReplay, dogwoodReplayReport } from "../../dogwood/replay-activity";
export type {
  DogwoodReplayArgs,
  DogwoodReplayReportArgs,
  ExpectedVerdict,
  PolicyReplayDispatch,
  PolicyReplayMode,
  PolicyReplayReport,
  ReplayDivergence,
  ReplayExpectation,
} from "../../dogwood/replay-activity";
