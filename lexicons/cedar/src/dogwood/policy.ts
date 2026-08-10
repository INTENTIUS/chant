/**
 * The dogwood entity model: a temporal policy, an event schema, a macro library.
 *
 * `Dogwood::TemporalPolicy` is `Cedar::Policy` plus the two clause forms
 * upstream's policy grammar adds. Its head — annotations, effect, the three
 * scope positions — is Cedar's, byte for byte, which is why `./serialize.ts`
 * renders it with the cedar serializer's own `renderPolicyHead` rather than a
 * copy of it. Only the `cond` rule differs:
 *
 * ```
 * cond = { cond_kw ~ (extension_marker | guardrails_tag? ~ "{" ~ expr ~ "}") }
 * ```
 *
 * — so a clause is `when { … }`, `when guardrails { … }`, or
 * `when temporal { … }`, and the same three under `unless`. `guardrails` is
 * transparent sugar for a bare Cedar expression (upstream discards the tag
 * during lowering); `temporal { … }` is a genuine sub-language dispatched to a
 * different parser.
 *
 * These are not schema-driven the way `Cedar::Policy`'s generated class is.
 * Codegen's input is the project's `.cedarschema`, which says nothing about
 * event kinds or temporal operators, so the dialect's classes are written here
 * and typed against the builders in `./temporal.ts`.
 */

import type { Declarable } from "@intentius/chant/declarable";
import { createResource } from "@intentius/chant/runtime";
import type { CedarEffect, CedarScope } from "../serializer";
import type { TemporalCondition } from "./temporal";
import type { EventSchema } from "./event-schema";
import type { MacroDefinition } from "./macros";

/** The lexicon these entities belong to — dogwood is a dialect of cedar, not a lexicon. */
export const DOGWOOD_LEXICON = "cedar";

/** The `entityType` of a temporal policy. */
export const DOGWOOD_POLICY_TYPE = "Dogwood::TemporalPolicy";

/** The `entityType` of an event schema. */
export const DOGWOOD_EVENT_SCHEMA_TYPE = "Dogwood::EventSchema";

/** The `entityType` of a macro library. */
export const DOGWOOD_MACRO_LIBRARY_TYPE = "Dogwood::MacroLibrary";

/** The `.dw` policy set written beside the cedar outputs. */
export const DOGWOOD_POLICY_FILENAME = "policies.dw";

/** The `.dwschema` event schema — what `dogwood validate --event-schema` reads. */
export const DOGWOOD_EVENT_SCHEMA_FILENAME = "events.dwschema";

/** The macro library — what `dogwood validate --macros` reads. */
export const DOGWOOD_MACRO_FILENAME = "macros.dw";

/**
 * The props of a `Dogwood::TemporalPolicy`.
 *
 * The first six mirror `CedarPolicyProps` exactly. The rest are the dialect's.
 */
export interface TemporalPolicyProps {
  /** Defaults to `permit` when omitted. */
  effect?: CedarEffect;
  /** Defaults to unconstrained (`{}`) when omitted. */
  principal?: CedarScope;
  /** Defaults to unconstrained (`{}`) when omitted. */
  action?: CedarScope;
  /** Defaults to unconstrained (`{}`) when omitted. */
  resource?: CedarScope;
  /** Cedar expression strings, each emitted as its own `when { … }` clause. */
  when?: string[];
  /** Cedar expression strings, each emitted as its own `unless { … }` clause. */
  unless?: string[];
  /** Emitted as `@key("value")`; an explicit `id` wins over the logical name. */
  annotations?: Record<string, string>;

  /** Each emitted as its own `when temporal { … }` clause. */
  whenTemporal?: TemporalCondition[];
  /** Each emitted as its own `unless temporal { … }` clause. */
  unlessTemporal?: TemporalCondition[];
  /**
   * Cedar expression strings emitted as `when guardrails { … }`.
   *
   * The tag carries no separate grammar — upstream parses the body as an
   * ordinary Cedar expression and discards the tag when lowering. It marks a
   * clause as a guardrail for a human reader and for whatever reads the source
   * after chant; it does not change what the policy means.
   */
  whenGuardrails?: string[];
  /** As {@link whenGuardrails}, negated. */
  unlessGuardrails?: string[];
}

/**
 * A temporal policy. Declare one per policy, the same way as `Cedar::Policy`:
 *
 * ```ts
 * export const readAfterLogin = new TemporalPolicy({
 *   action: { eq: 'Drupe::Action::"Read"' },
 *   whenTemporal: [
 *     formerly("1h", predicate('Drupe::Action::"Login"', "response", {
 *       "input.user": ctx("input.user"),
 *     })),
 *   ],
 * });
 * ```
 */
export const TemporalPolicy = createResource(DOGWOOD_POLICY_TYPE, DOGWOOD_LEXICON, {}) as unknown as new (
  props: TemporalPolicyProps,
) => Declarable;

/** The props of a `Dogwood::EventSchema`. */
export interface EventSchemaProps {
  /** Built with `eventSchema()` or `defaultEventSchema()`. */
  schema: EventSchema;
  /** Defaults to {@link DOGWOOD_EVENT_SCHEMA_FILENAME}. */
  filename?: string;
}

/** The service half of the schema, emitted as `.dwschema` text. */
export const TemporalEventSchema = createResource(DOGWOOD_EVENT_SCHEMA_TYPE, DOGWOOD_LEXICON, {}) as unknown as new (
  props: EventSchemaProps,
) => Declarable;

/** The props of a `Dogwood::MacroLibrary`. */
export interface MacroLibraryProps {
  macros: MacroDefinition[];
  /** Defaults to {@link DOGWOOD_MACRO_FILENAME}. Ignored when `inline` is set. */
  filename?: string;
  /**
   * Emit the definitions at the top of the policy set instead of into their own
   * file.
   *
   * A policy set's own `def` shadows a same-named library macro, so inlining is
   * how a project stops depending on whoever runs the CLI passing `--macros`.
   */
  inline?: boolean;
}

/** A `def cedar` / `def temporal` library, emitted as `.dw` text. */
export const TemporalMacroLibrary = createResource(DOGWOOD_MACRO_LIBRARY_TYPE, DOGWOOD_LEXICON, {}) as unknown as new (
  props: MacroLibraryProps,
) => Declarable;
