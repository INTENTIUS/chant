/**
 * The policy set the replay Op checks against a recorded trace.
 *
 * The `Drupe` half is adapted from dogwood-policy/dogwood
 * @5063bcc2d6d6cf5024d1b0498e6cc8ef52cbcf0c (Apache-2.0),
 * `dogwood-docs/examples/read_after_login`.
 *
 * Two policies, one of each kind, because a project's `.cedar` half and its
 * `.dw` half are one policy set with two halves:
 *
 * - `ownerRead` is ordinary Cedar over the application's own model. `chant
 *   build` writes it to `dist/policies.cedar` and the JSON policy set beside
 *   it. Everything it asserts is decidable from the source.
 * - `readAfterLogin` is the dialect, over the gateway that fronts the app. The
 *   same build writes it to `dist/policies.dw`, and it is the one a replay can
 *   disagree with, because what it decides depends on a history no build can
 *   see.
 *
 * The event schema is emitted explicitly rather than left to
 * `ServiceSchema::defaults()`: supplying any event schema opts out of the
 * built-in default entirely, so a project that ships one should ship the whole
 * shape. `defaultEventSchema()` reproduces upstream's `pinned.dwschema`,
 * including the `pin callerPrincipal = principal` that correlates every
 * temporal predicate to the deciding request's own principal.
 */

import {
  Policy,
  ReadAction,
  TemporalEventSchema,
  TemporalPolicy,
  dogwood,
} from "@intentius/chant-lexicon-cedar";

const { ctx, defaultEventSchema, formerly, predicate } = dogwood;

/** Owners read their own documents, with MFA. Plain Cedar — no history involved. */
export const ownerRead = new Policy({
  effect: "permit",
  principal: { is: "App::User" },
  action: { eq: ReadAction },
  resource: { is: "App::Document" },
  when: ["resource.owner == principal", "context.mfa == true"],
});

/**
 * Permit the gateway's `Read` only when the same user logged in within the
 * last hour.
 *
 * `{ "input.user": ctx("input.user") }` is the correlation: the past login's
 * `input.user` field, out of the logged record, has to equal the current
 * request's `context.input.user`. That is why the trace has to populate both
 * bags — the left side of that comparison comes from the logged record and the
 * right side from the `request_context` envelope.
 */
export const readAfterLogin = new TemporalPolicy({
  annotations: { id: "read_after_login" },
  effect: "permit",
  action: { eq: 'Drupe::Action::"Read"' },
  whenTemporal: [
    formerly(
      "1h",
      predicate('Drupe::Action::"Login"', "response", { "input.user": ctx("input.user") }),
    ),
  ],
});

/** The service half of the schema — `request` decides, `response` is history. */
export const events = new TemporalEventSchema({
  schema: defaultEventSchema(),
});
