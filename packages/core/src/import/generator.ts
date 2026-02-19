import type { TemplateIR } from "./parser";

/**
 * Represents a generated TypeScript file
 */
export interface GeneratedFile {
  readonly path: string;
  readonly content: string;
}

/**
 * Interface for TypeScript code generators that convert IR to TypeScript
 */
export interface TypeScriptGenerator {
  /**
   * Generate TypeScript files from intermediate representation
   * @param ir - Intermediate representation of the template
   * @returns Array of generated TypeScript files
   */
  generate(ir: TemplateIR): GeneratedFile[];
}
