/**
 * Intermediate representation of a template parameter
 */
export interface ParameterIR {
  readonly name: string;
  readonly type: string;
  readonly description?: string;
  readonly defaultValue?: unknown;
  readonly required?: boolean;
}

/**
 * Intermediate representation of a template resource
 */
export interface ResourceIR {
  readonly logicalId: string;
  readonly type: string;
  readonly properties: Record<string, unknown>;
  readonly metadata?: Record<string, unknown>;
  /** Name of the condition gating this resource (CloudFormation `Condition`
   * key, or equivalent), when the source template declares one (#2069). */
  readonly condition?: string;
}

/**
 * Intermediate representation of a declared template condition — a named
 * boolean expression (CloudFormation `Conditions` entry, or equivalent).
 * The expression is a parsed value tree: intrinsic envelopes and literals,
 * exactly what {@link ResourceIR.properties} values hold (#2069).
 */
export interface ConditionIR {
  readonly name: string;
  readonly expression: unknown;
}

/**
 * Intermediate representation of a template output (#2069).
 */
export interface OutputIR {
  readonly name: string;
  /** Parsed value tree, like {@link ResourceIR.properties} values. */
  readonly value: unknown;
  readonly description?: string;
  /** Cross-stack export name, when the output declares one. */
  readonly exportName?: unknown;
  /** Name of the condition gating this output, when declared. */
  readonly condition?: string;
}

/**
 * Intermediate representation of a parsed template
 */
export interface TemplateIR {
  readonly resources: ResourceIR[];
  readonly parameters: ParameterIR[];
  /** Declared conditions, in template order (#2069). */
  readonly conditions?: ConditionIR[];
  /** Template outputs, in template order (#2069). */
  readonly outputs?: OutputIR[];
  readonly metadata?: Record<string, unknown>;
  /** Sections or keys the parser read but import cannot carry, named so the
   * import surfaces them instead of dropping them silently (#2069). */
  readonly warnings?: string[];
}

/**
 * Interface for template parsers that convert external formats to IR
 */
export interface TemplateParser {
  /**
   * Parse template content into intermediate representation
   * @param content - Raw template content (JSON, YAML, etc.)
   * @returns Intermediate representation of the template
   */
  parse(content: string): TemplateIR;
}
