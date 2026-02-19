import type { Declarable } from "./declarable";
import type { LexiconOutput } from "./lexicon-output";

/**
 * Result of serialization that may include additional files (e.g. nested stack templates).
 */
export interface SerializerResult {
  /** Primary template content */
  primary: string;
  /** Additional files keyed by filename (e.g. "network.template.json" → content) */
  files?: Record<string, string>;
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
   */
  serialize(entities: Map<string, Declarable>, outputs?: LexiconOutput[]): string | SerializerResult;

  /**
   * Serialize a cross-lexicon reference to a foreign output.
   * Called when this lexicon consumes an output produced by another lexicon.
   * @param output - The LexiconOutput being referenced
   * @returns Lexicon-specific reference representation
   */
  serializeCrossRef?(output: LexiconOutput): unknown;
}
