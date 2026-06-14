import type { Declarable } from "./declarable";
import type { LexiconOutput } from "./lexicon-output";
import type { OwnershipMarker } from "./ownership";

/**
 * Build-time context passed to a serializer. Optional — serializers that don't
 * need it ignore the parameter.
 */
export interface SerializeContext {
  /**
   * When set, the serializer stamps this ownership marker into the target's
   * native metadata channel (AWS/Azure tags, K8s/GCP labels).
   */
  ownership?: OwnershipMarker;

  /**
   * The resolved project configuration, when a build was driven from a project
   * with a `chant.config.*`. Lets a serializer read its own lexicon-scoped
   * settings (e.g. the forgejo dialect's `forgejo.runnerLabels`). Undefined for
   * ad-hoc builds (e.g. context tools) that pass no config.
   */
  config?: Record<string, unknown>;
}

/**
 * Result of serialization that may include additional files (e.g. nested stack templates).
 */
export interface SerializerResult {
  /** Primary template content */
  primary: string;
  /** Additional files keyed by filename (e.g. "network.template.json" → content) */
  files?: Record<string, string>;
  /**
   * Non-fatal diagnostics produced during serialization (e.g. a dialect
   * dropping keys the target platform ignores). The build pipeline collects
   * these into its `warnings` array.
   */
  warnings?: string[];
}

/**
 * Serializer interface for chant specifications
 */
export interface Serializer {
  /**
   * Name of the lexicon
   */
  name: string;

  /**
   * Prefix used for rules in this lexicon
   */
  rulePrefix: string;

  /**
   * Serializes the entities to a string representation
   * @param entities - Map of entity name to Declarable entity
   * @param outputs - Optional array of LexiconOutputs produced by this lexicon
   * @param context - Optional build-time context (e.g. ownership marker)
   */
  serialize(
    entities: Map<string, Declarable>,
    outputs?: LexiconOutput[],
    context?: SerializeContext,
  ): string | SerializerResult;

  /**
   * Serialize a cross-lexicon reference to a foreign output.
   * Called when this lexicon consumes an output produced by another lexicon.
   * @param output - The LexiconOutput being referenced
   * @returns Lexicon-specific reference representation
   */
  serializeCrossRef?(output: LexiconOutput): unknown;
}
