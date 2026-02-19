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
}

/**
 * Intermediate representation of a parsed template
 */
export interface TemplateIR {
  readonly resources: ResourceIR[];
  readonly parameters: ParameterIR[];
  readonly metadata?: Record<string, unknown>;
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
