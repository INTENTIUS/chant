/**
 * A gateway policy set for Bedrock AgentCore: one plain-Cedar wall and two
 * temporal rules, staged log-only before they bind.
 *
 * `chant build` writes three artifacts from the declarations below — `.cedar`
 * text and its JSON companion for the Cedar policy, `policies.dw` for the
 * temporal ones, and `events.dwschema` for the event schema they are written
 * against. Those are the files a `dogwood validate` run or any Cedar evaluator
 * reads. The `gatewayPolicies` export beneath them is the *deployment* view:
 * the props `AWS::BedrockAgentCore::Policy` takes, rendered from the same
 * declarations by the same renderers.
 *
 * Two things are worth watching here.
 *
 * The definition union has two arms and the policy picks its own. A plain
 * Cedar policy lands in `Definition.Cedar.Statement`; a temporal one lands in
 * `Definition.Policy.Statement`, the language-agnostic arm, carrying `.dw`
 * text. Nobody chooses that by hand, which is the point — choosing wrong is a
 * deploy-time parse error against a Cedar parser that has never heard of
 * `when temporal`.
 *
 * And the temporal rules ship `"log-only"`. `EnforcementMode: LOG_ONLY` is
 * evaluated on every request and its decision is observed rather than
 * returned, so a rule whose behaviour depends on traffic — which is every
 * temporal rule — can be watched against real sessions before it starts
 * denying anything. Promoting it is one token.
 */

import {
  ApproveAction,
  DeleteAction,
  Policy,
  TemporalEventSchema,
  TemporalMacroLibrary,
  TemporalPolicy,
  WriteAction,
  agentCorePolicyResource,
  agentCoreStagedPolicy,
  dogwood,
  type AgentCorePolicyDefinition,
  type AgentCoreEnforcementMode,
} from "@intentius/chant-lexicon-cedar";

const { compare, ctx, defaultEventSchema, defaultMacroLibrary, formerly, predicate, sumWithin, varRef } = dogwood;

/** Which policy engine these deploy into. In a real project, `engine.ref()`. */
const POLICY_ENGINE_ID = "GatewayEngine-abcdefghij";

// ── The schema half ───────────────────────────────────────────────

/**
 * The event schema the temporal rules are written against.
 *
 * Emitted rather than assumed. Supplying any event schema opts out of
 * upstream's built-in default wholesale, so `defaultEventSchema()` reproduces
 * that default — request/response/error, each pinned to the deciding request's
 * principal — and the pin is then visible in the diff instead of being a fact
 * about someone else's binary.
 */
export const gatewayEvents = new TemporalEventSchema({
  schema: defaultEventSchema(),
});

/**
 * The default macro library, emitted into the policy set itself.
 *
 * `sum_within` below is a macro call, not an operator: it lives in a swappable
 * standard library that a caller passing `--macros` replaces entirely.
 * Inlining the definitions turns an assumption about the other end into a file
 * this project controls.
 */
export const gatewayMacros = new TemporalMacroLibrary({
  macros: defaultMacroLibrary(),
  inline: true,
});

// ── The Cedar wall ────────────────────────────────────────────────

/**
 * Default deny: a service account writes or deletes nothing unless the request
 * arrived authenticated.
 *
 * Plain Cedar — no history involved — so it lands in `Definition.Cedar`, and
 * it ships enforcing on day one. There is nothing to observe about a rule that
 * reads one field of the request.
 */
export const denyUnauthenticatedWrite = new Policy({
  effect: "forbid",
  principal: { is: "App::ServiceAccount" },
  action: { in: [WriteAction, DeleteAction] },
  resource: { is: "App::Document" },
  unless: ["context.authenticated == true"],
});

// ── The temporal rules ────────────────────────────────────────────

/**
 * Approval before action: a write is permitted only if an approval for the
 * same document came back within the last hour.
 *
 * `formerly` is a parser primitive, so this needs no macro library at all. The
 * `1h` window is the operator's, and it is mandatory — there is no
 * unbounded look-back in the language.
 */
export const writeNeedsApproval = new TemporalPolicy({
  effect: "permit",
  principal: { is: "App::ServiceAccount" },
  action: { eq: WriteAction },
  resource: { is: "App::Document" },
  whenTemporal: [
    formerly(
      "1h",
      predicate(ApproveAction, "response", {
        "input.document": ctx("input.document"),
      }),
    ),
  ],
});

/**
 * A spend budget: no more writing once the session's writes have cost more
 * than 1000 over the last twelve hours.
 *
 * `sum_within` is the macro-call form — `sum_within(cost, 12h, …)` — expanding
 * to a `sum … for … where` over a `formerly` window. Written as a `forbid`
 * because a budget is an invariant, and a forbid beats every permit.
 */
export const sessionSpendBudget = new TemporalPolicy({
  effect: "forbid",
  principal: { is: "App::ServiceAccount" },
  action: { eq: WriteAction },
  resource: { is: "App::Document" },
  whenTemporal: [
    compare(
      sumWithin(
        "cost",
        "12h",
        predicate(WriteAction, "response", { "output.cost": varRef("cost") }),
      ),
      ">",
      1000,
    ),
  ],
});

// ── The AgentCore deployment view ─────────────────────────────────

/**
 * A stand-in for the aws lexicon's generated `BedrockAgentCorePolicy`.
 *
 * The cedar lexicon does not depend on the aws lexicon — Cedar is
 * vendor-neutral and AgentCore is one evaluator among several — so this example
 * uses a plain object carrying the exact prop names the generated class
 * declares. Swapping it for the real thing in a project that installs both is a
 * one-line change:
 *
 * ```ts
 * import { BedrockAgentCorePolicy } from "@intentius/chant-lexicon-aws";
 *
 * export const approvalPolicy = new BedrockAgentCorePolicy({
 *   PolicyEngineId: engine.ref(),
 *   ...agentCoreStagedPolicy("writeNeedsApproval", writeNeedsApproval, "log-only"),
 * });
 * ```
 *
 * The example cannot use the real class as it stands: the shipped cedar
 * examples are built against the cedar serializer alone, so an aws entity in
 * this tree would have no serializer to emit it.
 */
interface BedrockAgentCorePolicyProps {
  PolicyEngineId: string;
  Name: string;
  Definition: AgentCorePolicyDefinition;
  EnforcementMode?: AgentCoreEnforcementMode;
  Description?: string;
}

/**
 * One `AWS::BedrockAgentCore::Policy` per declaration, with its stage.
 *
 * The Cedar wall enforces. The two temporal rules are log-only, which is where
 * a temporal policy starts: `formerly within 1h` cannot be reasoned about from
 * the source, because whether it fires depends on traffic nobody has replayed.
 * Promoting one is changing `"log-only"` to `"enforce"` on its line.
 */
export const gatewayPolicies: Record<string, BedrockAgentCorePolicyProps> = {
  denyUnauthenticatedWrite: agentCorePolicyResource(
    "denyUnauthenticatedWrite",
    denyUnauthenticatedWrite,
    POLICY_ENGINE_ID,
    {
      stage: "enforce",
      description: "Service accounts write nothing on an unauthenticated request.",
    },
  ),

  writeNeedsApproval: {
    PolicyEngineId: POLICY_ENGINE_ID,
    ...agentCoreStagedPolicy("writeNeedsApproval", writeNeedsApproval, "log-only", {
      description: "A write needs an approval for the same document within the hour.",
    }),
  },

  sessionSpendBudget: {
    PolicyEngineId: POLICY_ENGINE_ID,
    ...agentCoreStagedPolicy("sessionSpendBudget", sessionSpendBudget, "log-only", {
      description: "No writing past a 1000-unit spend over twelve hours.",
    }),
  },
};
