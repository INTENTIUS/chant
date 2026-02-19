/**
 * Parsed schema result for a single schema file.
 */
export interface ParseResult {
  typeName: string;
  description?: string;
  properties: Map<string, ParsedProperty>;
  attributes: string[];
}

export interface ParsedProperty {
  name: string;
  type: string;
  required: boolean;
  description?: string;
}

/**
 * Parse a single schema file into a ParseResult.
 *
 * TODO: Implement parsing for your schema format.
 */
export function parseSchema(name: string, content: string): ParseResult {
  throw new Error(`TODO: implement parseSchema for ${name}`);
}
