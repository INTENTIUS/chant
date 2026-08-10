/**
 * The checked-in trace, as typed events.
 *
 * Adapted from dogwood-policy/dogwood@5063bcc2d6d6cf5024d1b0498e6cc8ef52cbcf0c
 * (Apache-2.0), `dogwood-docs/examples/read_after_login`. The verdicts the
 * expectations below assert are the ones the #1657 verification recorded from
 * a real run of the built binary against that bundle: `@0 DENY`,
 * `@10 ALLOW [rules: 0]`, `@7200 DENY`, exit 0.
 *
 * `read-after-login.log` beside this file is what {@link renderTrace} produces
 * from these events, byte for byte — the test asserts it, so the fixture
 * cannot drift from the builder. The `.log` carries no attribution header of
 * its own because the trace format has **no comment syntax**: a `//` is an
 * ordinary part of a value, and a header line would be parsed as an event and
 * rejected with "timepoint must start with `@`".
 *
 * Every event populates both bags. `input` is written once, in `context`, and
 * {@link traceEvent} puts it in the `request_context` envelope *and* in the
 * logged record — which is the only combination in which
 * `formerly within 1h Login::response{ input.user: context.input.user }` can
 * match at all. Supplying it to one bag would leave the replay green and
 * meaningless.
 */

import { dogwood } from "@intentius/chant-lexicon-cedar";
import type { ReplayExpectation, TraceEvent } from "@intentius/chant-lexicon-cedar/dogwood/index";

const { entityRef, traceEvent } = dogwood;

const ALICE = 'Drupe::OAuthUser::"alice"';
const GATEWAY = 'Drupe::Gateway::"gw1"';

/** The session envelope every line in this trace shares. */
const session = {
  scope: { principal: ALICE, resource: GATEWAY },
  context: { input: { user: "alice" } },
} as const;

/** Fields the event schema injects into the logged record and nowhere else. */
function injected(requestId: string) {
  return {
    callerPrincipal: entityRef(ALICE),
    callerResource: entityRef(GATEWAY),
    requestId,
  };
}

/** Alice logs in at t=0, reads at t=10, reads again two hours later. */
export const readAfterLoginTrace: TraceEvent[] = [
  traceEvent({ ...session, timestamp: 0, action: 'Drupe::Action::"Login"', record: injected("u1") }),
  traceEvent({
    ...session,
    timestamp: 0,
    action: 'Drupe::Action::"Login"',
    kind: "response",
    record: injected("u1"),
  }),
  traceEvent({ ...session, timestamp: 10, action: 'Drupe::Action::"Read"', record: injected("u2") }),
  traceEvent({ ...session, timestamp: 7200, action: 'Drupe::Action::"Read"', record: injected("u3") }),
];

/**
 * What each decision point must decide.
 *
 * Three expectations for four trace lines: `Login::response` is history-only
 * under the default event schema, so it contributes to the window and produces
 * no verdict. That mismatch is exactly why these are written against
 * timestamps rather than against the decision-stream index.
 */
export const readAfterLoginExpectations: ReplayExpectation[] = [
  {
    timestamp: 0,
    verdict: "deny",
    note: "the login request itself is not permitted by this policy set",
  },
  {
    timestamp: 10,
    verdict: "allow",
    determiningRules: [0],
    note: "read_after_login carries it — the login is ten seconds old",
  },
  {
    timestamp: 7200,
    verdict: "deny",
    note: "the login is two hours stale, outside the 1h window",
  },
];
