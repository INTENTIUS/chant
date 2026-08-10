/**
 * Typed embedding of a cedar policy into `AWS::VerifiedPermissions::Policy`
 * (#1652).
 *
 * The aws lexicon keeps the deployment vehicle — its generated
 * `VerifiedPermissionsPolicy` takes a required `PolicyStoreId` and a required
 * `Definition`, and the `Definition.Static.Statement` inside it is an opaque
 * string. Opaque is the problem the whole cedar lexicon exists to remove: today
 * a team writes that string with `${}` templating and finds out at deploy time
 * whether the entity type exists.
 *
 * This module closes the loop without joining the two lexicons together. It
 * emits the *string* and the *JSON envelope* AVP expects and stops there:
 * nothing here imports `@intentius/chant-lexicon-aws`, and nothing here needs
 * to. A project that has both installed writes
 *
 * ```ts
 * new VerifiedPermissionsPolicy({
 *   PolicyStoreId: store.ref(),
 *   Definition: avpPolicyDefinition("ownerRead", ownerReadProps),
 * });
 * ```
 *
 * and the statement is the same text `chant build` writes to `.cedar`, rendered
 * by the same renderer, with `@id` intact.
 *
 * ### Why no dependency, and why the example uses plain objects
 *
 * A cedar → aws dependency would invert the epic's decision that Cedar is
 * vendor-neutral and AVP is one of several evaluators, and it would make the
 * cedar lexicon unbuildable without the aws one. The seam is therefore the
 * data shape, which is stable CloudFormation, and
 * `examples/avp-embedding/` demonstrates the pairing with a plain-object stand-in
 * for `VerifiedPermissionsPolicy` — the shipped examples build with the cedar
 * serializer alone, so a real cross-lexicon example could not run in this
 * repo's example harness at all. The stand-in carries the exact prop names the
 * generated class declares (`PolicyStoreId`, `Definition`, `Name`), so the
 * substitution is a one-line edit in a real project.
 */

import type { Declarable } from "@intentius/chant/declarable";
import type { OwnershipMarker } from "@intentius/chant/ownership";
import {
  cedarPolicyRecords,
  renderPolicyText,
  resolvePolicyId,
  type CedarPolicyProps,
} from "../serializer";
import { policyToJson, type PolicyJson } from "../spec/wasm";
import { encodeOwnershipDescription } from "./ownership";

/** `Definition.Static` — the static-policy half of the AVP definition union. */
export interface AvpStaticDefinition {
  Statement: string;
  Description?: string;
}

/** The `Definition` property of `AWS::VerifiedPermissions::Policy`. */
export interface AvpPolicyDefinition {
  Static: AvpStaticDefinition;
}

/** The props of `AWS::VerifiedPermissions::Policy` this module can fill. */
export interface AvpPolicyResource {
  PolicyStoreId: string;
  Definition: AvpPolicyDefinition;
}

export interface AvpEmbedOptions {
  /**
   * Ownership marker to stamp into the description — the per-policy channel
   * (see ./ownership.ts). Supply it and `describeResources`/`exportResources`
   * can tell this policy from one somebody added in the console.
   */
  ownership?: OwnershipMarker;
  /** The author's own description, kept ahead of the marker. */
  description?: string;
  /** Override the Cedar id. Defaults to the serializer's own derivation. */
  policyId?: string;
}

function propsRecord(props: CedarPolicyProps | Record<string, unknown>): Record<string, unknown> {
  return props as Record<string, unknown>;
}

/**
 * The Cedar policy text for one policy — the exact string
 * `Definition.Static.Statement` wants.
 *
 * `name` is the chant entity name; the `@id` annotation the statement carries
 * is derived from it the same way the serializer derives it, which is what lets
 * the live observation match a policy in the store back to the entity that
 * declared it.
 */
export function avpStatement(
  name: string,
  props: CedarPolicyProps | Record<string, unknown>,
  options: AvpEmbedOptions = {},
): string {
  const record = propsRecord(props);
  return renderPolicyText(options.policyId ?? resolvePolicyId(name, record), record);
}

/**
 * The Cedar JSON policy format for one policy — for an evaluator that takes
 * JSON rather than text (`cedar-agent`, an embedded `cedar-wasm`).
 *
 * Not what AVP's `Definition` wants; AVP takes the text. Emitted here so the
 * seam is documented in both directions rather than only the AWS one.
 *
 * Built the way the serializer's JSON leg is built (#1653): render the text,
 * then hand it to `cedar-wasm`, so what comes back is Cedar's own reading
 * rather than a second, worse encoder. Throws on text Cedar refuses — this is
 * an authoring-time call, and a policy the module cannot read is a defect the
 * caller wants to hear about rather than a `undefined` to thread through.
 */
export function avpStatementJSON(
  name: string,
  props: CedarPolicyProps | Record<string, unknown>,
  options: AvpEmbedOptions = {},
): PolicyJson {
  const statement = avpStatement(name, props, options);
  const converted = policyToJson(statement);
  if (!converted.ok) {
    throw new Error(`cedar: ${name} did not parse, so no JSON form could be produced — ${converted.error}`);
  }
  return converted.value;
}

/**
 * The `Definition` property of `AWS::VerifiedPermissions::Policy`.
 *
 * With `options.ownership` set, the description carries chant's marker — the
 * only per-policy ownership channel AVP has, because policies are not taggable.
 */
export function avpPolicyDefinition(
  name: string,
  props: CedarPolicyProps | Record<string, unknown>,
  options: AvpEmbedOptions = {},
): AvpPolicyDefinition {
  const record = propsRecord(props);
  const policyId = options.policyId ?? resolvePolicyId(name, record);
  const description = options.ownership
    ? encodeOwnershipDescription(options.description, options.ownership, policyId)
    : options.description?.trim();

  return {
    Static: {
      Statement: renderPolicyText(policyId, record),
      ...(description ? { Description: description } : {}),
    },
  };
}

/**
 * Both required props of `AWS::VerifiedPermissions::Policy`, ready to spread
 * into the generated class.
 *
 * `PolicyStoreId` is a string here rather than an AttrRef because this module
 * does not know the aws lexicon's reference types. A project passes
 * `store.ref()` in place of the literal and TypeScript is satisfied by the
 * generated class's own prop type, not by this one.
 */
export function avpPolicyResource(
  name: string,
  props: CedarPolicyProps | Record<string, unknown>,
  policyStoreId: string,
  options: AvpEmbedOptions = {},
): AvpPolicyResource {
  return { PolicyStoreId: policyStoreId, Definition: avpPolicyDefinition(name, props, options) };
}

/**
 * Every `Cedar::Policy` in a build, rendered as AVP definitions and keyed by
 * chant entity name.
 *
 * The whole-set form: one call turns a policy set into the definitions a stack
 * of `VerifiedPermissionsPolicy` declarations needs, with references between
 * declared entities already walked (that is what `cedarPolicyRecords` does).
 */
export function avpPolicySet(
  entities: Map<string, Declarable>,
  options: AvpEmbedOptions = {},
): Record<string, AvpPolicyDefinition> {
  const out: Record<string, AvpPolicyDefinition> = {};
  for (const { name, id, props } of cedarPolicyRecords(entities)) {
    out[name] = avpPolicyDefinition(name, props, { ...options, policyId: id });
  }
  return out;
}
