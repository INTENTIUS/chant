/**
 * The replay Op: build the policy set, replay it against the recorded trace,
 * report divergence.
 *
 * ```
 * npx chant run policy-replay
 * ```
 *
 * `PolicyReplayOp` ships from the cedar lexicon rather than from the temporal
 * one, because it hands back an Op and nothing else — see
 * `src/dogwood/replay-op.ts` for the packaging decision. That is why this file
 * imports one package and the Op runs on the local executor with no Temporal
 * server in the picture.
 *
 * The scheduled form, for a project that already installs the temporal
 * lexicon, is the same factory plus a schedule of its own:
 *
 * ```ts
 * import { TemporalSchedule } from "@intentius/chant-lexicon-temporal";
 *
 * export const schedule = new TemporalSchedule({
 *   scheduleId: "policy-replay-schedule",
 *   spec: { cronExpressions: ["0 6 * * *"] },
 *   action: { workflowType: "policyReplayWorkflow", taskQueue: "policy-replay" },
 * });
 * ```
 *
 * The Replay phase needs a `dogwood` binary — upstream ships only a Rust CLI,
 * with no npm package and no wasm build. Build one from
 * `dogwood-policy/dogwood` and point chant at it with `$CHANT_DOGWOOD_BINARY`,
 * `cedar.dogwood.binary` in `chant.config.json`, or `dogwood` on `PATH`.
 * Without one the phase fails loudly rather than reporting zero divergences,
 * which is the whole point: a replay that did not happen is not a replay that
 * found nothing.
 */

import { PolicyReplayOp } from "@intentius/chant-lexicon-cedar";
import { readAfterLoginExpectations } from "../trace/read-after-login";

export const { op } = PolicyReplayOp({
  name: "policy-replay",
  overview: "Replay read_after_login against a recorded gateway session and report divergence",

  // `npm run build` writes dist/policies.cedar, dist/policies.dw and
  // dist/events.dwschema; the action schema is a project file, not an emitted
  // one, so it is named where it lives.
  policiesPath: "dist/policies.dw",
  policySchemaPath: "schema.cedarschema",
  eventSchemaPath: "dist/events.dwschema",

  tracePath: "trace/read-after-login.log",
  expect: readAfterLoginExpectations,

  // "report" prints the divergence table. "issue" and "pull-request" render
  // the same markdown as a body for whatever opens them.
  onFinding: "report",
});

export default op;
