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

  /**
   * True when the generator places its own files (#2964). Core then calls
   * `generate()` once with the whole IR and writes exactly the files it
   * returns, at the paths it gives, however many resources the IR holds.
   *
   * Leave it unset for core's default layout: up to three resources are
   * generated in one call, and above three core splits the IR into
   * per-category files (`storage.ts`, `compute.ts`, `network.ts`,
   * `other.ts`) plus an `index.ts` barrel, keeping only the first file of
   * each call. Set it when your resources refer to each other across that
   * split, or when one `generate()` call returns several modules.
   */
  readonly ownsLayout?: boolean;
}
