/**
 * Typed embedding of a cedar or dogwood policy into
 * `AWS::BedrockAgentCore::Policy` (#1660).
 *
 * The aws lexicon keeps the deployment vehicle, exactly as it does for AVP
 * (#1652, `../avp/embed.ts`). What differs is the shape of the vehicle:
 * AgentCore's `Definition` is a two-arm `oneOf`, not the single `Static` arm
 * `AWS::VerifiedPermissions::Policy` has —
 *
 * ```jsonc
 * "PolicyDefinition": {
 *   "oneOf": [{ "required": ["Cedar"] }, { "required": ["Policy"] }]
 * }
 * ```
 *
 * — where `Cedar.Statement` is plain Cedar and `Policy.Statement` is the
 * language-agnostic arm. That second arm is what makes AgentCore the
 * deployment target for the dogwood dialect: a `.dw` policy is a Cedar policy
 * with `when temporal { … }` clauses, which the `Cedar` arm has no business
 * accepting, and the `Policy` arm exists precisely so a policy engine can be
 * handed something that is not plain Cedar.
 *
 * A project that has both lexicons installed writes
 *
 * ```ts
 * new BedrockAgentCorePolicy({
 *   PolicyEngineId: engine.ref(),
 *   Name: "writeNeedsApproval",
 *   ...agentCoreStagedPolicy("writeNeedsApproval", writeNeedsApproval, "log-only"),
 * });
 * ```
 *
 * and the statement is the same text `chant build` writes to `policies.dw`,
 * rendered by the same renderer, with `@id` intact.
 *
 * ### Why no dependency, and why the example uses plain objects
 *
 * Same rule as `../avp/embed.ts` and for the same reason: a cedar → aws
 * dependency would invert the epic's decision that Cedar is vendor-neutral and
 * make the cedar lexicon unbuildable without the aws one. Nothing here imports
 * `@intentius/chant-lexicon-aws`. The seam is the data shape, which is stable
 * CloudFormation, and the prop names below are the generated class's own
 * (`PolicyEngineId`, `Name`, `Definition`, `EnforcementMode`, `Description`),
 * so substituting the real class is a one-line edit. `examples/agentcore-policy/`
 * demonstrates the pairing with a plain-object stand-in, because the shipped
 * cedar examples build against the cedar serializer alone and an `AWS::*` entity
 * declared in that tree would have no serializer to emit it.
 *
 * ### What this module refuses
 *
 * Templates. `AWS::VerifiedPermissions::Policy` has a `TemplateLinked` arm;
 * AgentCore's `Definition` union does not, so a statement carrying a
 * `?principal` or `?resource` slot has nowhere to go and would be rejected at
 * deploy time with an error about the policy text rather than about the slot.
 * {@link agentCoreStatement} throws instead, at authoring time, naming the
 * declaration.
 */

import { isDeclarable, type Declarable } from "@intentius/chant/declarable";
import {
  cedarPolicyRecords,
  getProps,
  renderPolicyText,
  resolvePolicyId,
  CEDAR_POLICY_TYPE,
  type CedarPolicyProps,
} from "../serializer";
import { dogwoodPolicyRecords, renderTemporalPolicyText } from "../dogwood/serialize";
import { DOGWOOD_POLICY_TYPE, type TemporalPolicyProps } from "../dogwood/policy";
import { enforcementMode, type AgentCoreEnforcementMode, type AgentCoreStage } from "./enforcement";

// ── The CloudFormation shapes ─────────────────────────────────────

/** `Definition.Cedar` — the plain-Cedar arm of the definition union. */
export interface AgentCoreCedarDefinition {
  Statement: string;
}

/** `Definition.Policy` — the language-agnostic arm, which carries `.dw` text. */
export interface AgentCoreLanguageDefinition {
  Statement: string;
}

/**
 * The `Definition` property of `AWS::BedrockAgentCore::Policy`.
 *
 * A union rather than a record with two optional keys, because upstream's
 * schema is a `oneOf`: a definition carrying both arms is rejected, and a type
 * that can express it is a type that lets a caller build one.
 */
export type AgentCorePolicyDefinition =
  | { Cedar: AgentCoreCedarDefinition; Policy?: never }
  | { Policy: AgentCoreLanguageDefinition; Cedar?: never };

/** The props of `AWS::BedrockAgentCore::Policy` this module can fill. */
export interface AgentCorePolicyResource {
  PolicyEngineId: string;
  Name: string;
  Definition: AgentCorePolicyDefinition;
  EnforcementMode?: AgentCoreEnforcementMode;
  Description?: string;
}

/**
 * A policy paired with its rollout stage — everything but the engine id.
 *
 * Spreadable into the generated class, which is the point: the caller supplies
 * `PolicyEngineId` (an AttrRef this module has no type for) and this supplies
 * the three props that come from the declaration.
 */
export interface AgentCoreStagedPolicy {
  Name: string;
  Definition: AgentCorePolicyDefinition;
  EnforcementMode: AgentCoreEnforcementMode;
  Description?: string;
}

// ── Upstream's own limits ─────────────────────────────────────────

/** `Statement` minLength, on both arms of the union. */
export const AGENTCORE_STATEMENT_MIN = 35;

/** `Statement` maxLength, on both arms of the union. */
export const AGENTCORE_STATEMENT_MAX = 10000;

/** `Name` — an identifier, and create-only, so a rename replaces the policy. */
export const AGENTCORE_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;

/**
 * `?principal` / `?resource` — Cedar's two template slots.
 *
 * Scanned over the whole statement rather than only the scope positions, which
 * is where a slot can legally appear. Inside a `temporal { … }` clause the `?`
 * sigil means a macro parameter, so in principle a macro parameter named
 * `?principal` would read as a slot here — but macro parameters are legal only
 * inside a macro *definition* body, and this module renders policies, never
 * definitions. There is nowhere in a policy statement for the pattern to mean
 * anything else.
 */
const TEMPLATE_SLOT = /\?(?:principal|resource)\b/;

// ── Options ───────────────────────────────────────────────────────

/** What a caller can hand the embedding: one policy, or a whole build's worth. */
export type AgentCorePolicySource =
  | Declarable
  | CedarPolicyProps
  | TemporalPolicyProps
  | Record<string, unknown>
  | Map<string, Declarable>;

export interface AgentCoreEmbedOptions {
  /** Override the policy id. Defaults to the serializer's own derivation. */
  policyId?: string;
  /**
   * Force an arm of the `Definition` union.
   *
   * The default reads the policy: temporal clauses take the `Policy` arm, plain
   * Cedar takes the `Cedar` arm. Forcing `"dogwood"` on plain Cedar is
   * legitimate — dogwood embeds Cedar, so the `Policy` arm accepts it, and a
   * policy set that will grow temporal clauses need not change arms later.
   * Forcing `"cedar"` on temporal text is not, and throws.
   */
  language?: "cedar" | "dogwood";
  /** `Description` on the resource. Free prose; AgentCore does nothing with it. */
  description?: string;
}

// ── Rendering ─────────────────────────────────────────────────────

/** The dialect keys `TemporalPolicyProps` adds to `CedarPolicyProps`. */
const DOGWOOD_ONLY_PROPS = ["whenTemporal", "unlessTemporal", "whenGuardrails", "unlessGuardrails"] as const;

function hasTemporalProps(props: Record<string, unknown>): boolean {
  return DOGWOOD_ONLY_PROPS.some((key) => {
    const value = props[key];
    return Array.isArray(value) ? value.length > 0 : value !== undefined;
  });
}

/** One rendered statement, and which arm it belongs in. */
interface RenderedStatement {
  text: string;
  /** True when the text is `.dw` rather than plain Cedar. */
  temporal: boolean;
}

function renderRecord(name: string, props: Record<string, unknown>, options: AgentCoreEmbedOptions): RenderedStatement {
  const temporal = hasTemporalProps(props);
  const id = options.policyId ?? resolvePolicyId(name, props);
  return { text: temporal ? renderTemporalPolicyText(id, props) : renderPolicyText(id, props), temporal };
}

/**
 * Every policy in a build, as one statement.
 *
 * Cedar policies first, then temporal ones, both in declaration order, so the
 * text is stable across builds. Any temporal policy in the set puts the whole
 * statement in the `Policy` arm — which is correct rather than a compromise: a
 * `.dw` file holds plain Cedar policies too, and splitting the set across two
 * AgentCore policies to keep one of them in the `Cedar` arm would give the two
 * halves separate `EnforcementMode` dials for no reason.
 */
function renderPolicySet(entities: Map<string, Declarable>): RenderedStatement {
  const parts: string[] = [];
  for (const { id, props } of cedarPolicyRecords(entities)) parts.push(renderPolicyText(id, props));

  const temporalRecords = dogwoodPolicyRecords(entities);
  for (const { id, props } of temporalRecords) parts.push(renderTemporalPolicyText(id, props));

  return { text: parts.join("\n\n"), temporal: temporalRecords.length > 0 };
}

function render(
  name: string,
  source: AgentCorePolicySource,
  options: AgentCoreEmbedOptions,
): RenderedStatement {
  if (source instanceof Map) return renderPolicySet(source);

  if (isDeclarable(source)) {
    if (source.entityType !== CEDAR_POLICY_TYPE && source.entityType !== DOGWOOD_POLICY_TYPE) {
      throw new Error(
        `cedar: "${name}" is a ${source.entityType}, which is not a policy — AWS::BedrockAgentCore::Policy embeds ${CEDAR_POLICY_TYPE} or ${DOGWOOD_POLICY_TYPE}.`,
      );
    }
    // Read straight off the entity: no reference walk, because a single
    // Declarable carries no map of the names its siblings were declared under.
    // A scope that names another declared entity needs the policy-set form,
    // which walks references the way the serializer does.
    const props = getProps(source);
    const temporal = source.entityType === DOGWOOD_POLICY_TYPE || hasTemporalProps(props);
    const id = options.policyId ?? resolvePolicyId(name, props);
    return { text: temporal ? renderTemporalPolicyText(id, props) : renderPolicyText(id, props), temporal };
  }

  return renderRecord(name, source as Record<string, unknown>, options);
}

function assertEmbeddable(name: string, statement: RenderedStatement): void {
  if (statement.text.length === 0) {
    throw new Error(`cedar: "${name}" rendered no policy text, so there is nothing for AgentCore to evaluate.`);
  }
  if (TEMPLATE_SLOT.test(statement.text)) {
    throw new Error(
      `cedar: the statement for "${name}" carries a Cedar template slot — AWS::BedrockAgentCore::Policy takes a static statement, and its Definition union has no template-linked arm. Write the ?principal/?resource slot as a concrete entity, or deploy the template through AWS::VerifiedPermissions::Policy instead.`,
    );
  }
  if (statement.text.length < AGENTCORE_STATEMENT_MIN) {
    throw new Error(
      `cedar: the statement for "${name}" is ${statement.text.length} characters and AgentCore's minimum is ${AGENTCORE_STATEMENT_MIN}.`,
    );
  }
  if (statement.text.length > AGENTCORE_STATEMENT_MAX) {
    throw new Error(
      `cedar: the statement for "${name}" is ${statement.text.length} characters and AgentCore's maximum is ${AGENTCORE_STATEMENT_MAX} — split it across policies, each with its own EnforcementMode.`,
    );
  }
}

// ── The seam ──────────────────────────────────────────────────────

/**
 * The policy text for one AgentCore policy — the exact string a `Statement`
 * wants, on whichever arm it lands.
 *
 * `name` is the chant entity name; the `@id` annotation the statement carries
 * is derived from it the same way the serializer derives it, so the statement
 * in the policy engine can be matched back to the declaration that produced it.
 */
export function agentCoreStatement(
  name: string,
  source: AgentCorePolicySource,
  options: AgentCoreEmbedOptions = {},
): string {
  const statement = render(name, source, options);
  assertEmbeddable(name, statement);
  return statement.text;
}

/**
 * The `Definition` property of `AWS::BedrockAgentCore::Policy`.
 *
 * The arm is chosen by what the policy is: a `Dogwood::TemporalPolicy`, or any
 * props carrying a temporal clause, lands in `Definition.Policy`; plain Cedar
 * lands in `Definition.Cedar`. `options.language` overrides in the one
 * direction that is safe (see {@link AgentCoreEmbedOptions.language}).
 */
export function agentCorePolicyDefinition(
  name: string,
  source: AgentCorePolicySource,
  options: AgentCoreEmbedOptions = {},
): AgentCorePolicyDefinition {
  const statement = render(name, source, options);
  assertEmbeddable(name, statement);

  if (options.language === "cedar" && statement.temporal) {
    throw new Error(
      `cedar: "${name}" has temporal clauses, so it cannot go in Definition.Cedar — that arm is plain Cedar, and AgentCore's Cedar parser has no \`when temporal\` rule. Drop \`language: "cedar"\` and it lands in Definition.Policy.`,
    );
  }

  const dogwood = options.language === "dogwood" || (options.language === undefined && statement.temporal);
  return dogwood ? { Policy: { Statement: statement.text } } : { Cedar: { Statement: statement.text } };
}

/**
 * A policy and its rollout stage, ready to spread into the generated class.
 *
 * The staged-rollout pattern in one call, which is the point (#1660, and the
 * loomster#171 showcase seam): shipping log-only and promoting to enforcing is
 * a one-token diff, not a hand-edited `EnforcementMode` string somewhere else
 * in the template. See ./enforcement.ts for why observe-before-enforce is the
 * default reading of a temporal policy rather than an optional nicety.
 */
export function agentCoreStagedPolicy(
  name: string,
  source: AgentCorePolicySource,
  stage: AgentCoreStage,
  options: AgentCoreEmbedOptions = {},
): AgentCoreStagedPolicy {
  return {
    Name: agentCorePolicyName(name),
    Definition: agentCorePolicyDefinition(name, source, options),
    EnforcementMode: enforcementMode(stage),
    ...(options.description ? { Description: options.description } : {}),
  };
}

/**
 * Every required prop of `AWS::BedrockAgentCore::Policy`, plus the stage.
 *
 * `PolicyEngineId` is a string here rather than an AttrRef because this module
 * does not know the aws lexicon's reference types. A project passes
 * `engine.ref()` in place of the literal and TypeScript is satisfied by the
 * generated class's own prop type, not by this one.
 */
export function agentCorePolicyResource(
  name: string,
  source: AgentCorePolicySource,
  policyEngineId: string,
  options: AgentCoreEmbedOptions & { stage?: AgentCoreStage } = {},
): AgentCorePolicyResource {
  const { stage, ...embed } = options;
  return {
    PolicyEngineId: policyEngineId,
    Name: agentCorePolicyName(name),
    Definition: agentCorePolicyDefinition(name, source, embed),
    ...(stage ? { EnforcementMode: enforcementMode(stage) } : {}),
    ...(embed.description ? { Description: embed.description } : {}),
  };
}

/**
 * Every policy in a build, as one AgentCore `Definition` each, keyed by chant
 * entity name.
 *
 * The whole-set form, and the one that walks references between declared
 * entities — that is what `cedarPolicyRecords`/`dogwoodPolicyRecords` do. One
 * definition per policy rather than one merged statement, because
 * `EnforcementMode` is a per-policy dial and merging would throw it away; hand
 * the map to {@link agentCorePolicyDefinition} instead when a single AgentCore
 * policy really should carry the whole set.
 */
export function agentCorePolicySet(
  entities: Map<string, Declarable>,
  options: AgentCoreEmbedOptions = {},
): Record<string, AgentCorePolicyDefinition> {
  const out: Record<string, AgentCorePolicyDefinition> = {};

  for (const { name, id, props } of cedarPolicyRecords(entities)) {
    out[name] = agentCorePolicyDefinition(name, props, { ...options, policyId: id });
  }
  for (const { name, id, props } of dogwoodPolicyRecords(entities)) {
    out[name] = agentCorePolicyDefinition(name, props, { ...options, policyId: id, language: "dogwood" });
  }

  return out;
}

/**
 * The chant entity name as an AgentCore `Name`.
 *
 * `Name` is create-only and matches `^[A-Za-z][A-Za-z0-9_]*$` — no hyphens,
 * which is why it is not the kebab-case policy id the `@id` annotation carries.
 * Checked rather than coerced: silently rewriting a name that is create-only
 * would mean a later rename replaces the policy without anyone having asked.
 */
export function agentCorePolicyName(name: string): string {
  if (!AGENTCORE_NAME_PATTERN.test(name)) {
    throw new Error(
      `cedar: "${name}" is not a legal AWS::BedrockAgentCore::Policy Name — it must match ${AGENTCORE_NAME_PATTERN.source} (letters, digits and underscores, starting with a letter).`,
    );
  }
  if (name.length > 48) {
    throw new Error(`cedar: the AgentCore policy Name "${name}" is ${name.length} characters and the maximum is 48.`);
  }
  return name;
}
