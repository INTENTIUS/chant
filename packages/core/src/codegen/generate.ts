/**
 * Generic generation pipeline orchestration.
 *
 * Provides the step sequencing, logging, warning collection, stats counting,
 * and artifact writing pattern. Individual steps (fetch, parse, etc.) are
 * supplied by the lexicon via callbacks.
 */

import { writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import type { NamingStrategy } from "./naming";

// ── Types ──────────────────────────────────────────────────────────

export interface GenerateOptions {
  force?: boolean;
  verbose?: boolean;
  dryRun?: boolean;
  schemaSource?: Map<string, Buffer>;
}

export interface GenerateResult {
  lexiconJSON: string;
  typesDTS: string;
  indexTS: string;
  resources: number;
  properties: number;
  enums: number;
  warnings: Array<{ file: string; error: string }>;
}

/**
 * A parsed result with enough structure for the pipeline to count stats.
 * Lexicons extend this with their own fields.
 */
export interface ParsedResult {
  propertyTypes: Array<{ name: string }>;
  enums: Array<unknown>;
}

export interface AugmentResult<T> {
  schemas: Map<string, Buffer>;
  extraResults?: T[];
  warnings?: Array<{ file: string; error: string }>;
}

export interface GeneratePipelineConfig<T extends ParsedResult> {
  /** Fetch or provide raw schema data. */
  fetchSchemas: (opts: { force?: boolean }) => Promise<Map<string, Buffer>>;

  /** Parse a single schema buffer into a result. Returns null to skip. */
  parseSchema: (typeName: string, data: Buffer) => T | null;

  /** Create a naming strategy from the parsed results. */
  createNaming: (results: T[]) => NamingStrategy;

  /** Generate lexicon JSON from results + naming. */
  generateRegistry: (results: T[], naming: NamingStrategy) => string;

  /** Generate TypeScript declarations. */
  generateTypes: (results: T[], naming: NamingStrategy) => string;

  /** Generate runtime index with factory exports. */
  generateRuntimeIndex: (results: T[], naming: NamingStrategy) => string;

  /** Optional pre-parse hook (patches, overlays, extra resources, etc.). */
  augmentSchemas?: (
    schemas: Map<string, Buffer>,
    opts: GenerateOptions,
    log: (msg: string) => void,
  ) => Promise<AugmentResult<T>>;

  /** Optional post-parse hook (add synthetic resources, fallbacks, etc.). */
  augmentResults?: (
    results: T[],
    opts: GenerateOptions,
    log: (msg: string) => void,
  ) => { results: T[]; warnings?: Array<{ file: string; error: string }> };
}

// ── Pipeline ───────────────────────────────────────────────────────

/**
 * Run a generation pipeline with the supplied config callbacks.
 */
export async function generatePipeline<T extends ParsedResult>(
  config: GeneratePipelineConfig<T>,
  opts: GenerateOptions = {},
): Promise<GenerateResult> {
  const log = opts.verbose
    ? (msg: string) => console.error(msg)
    : (_msg: string) => {};

  const warnings: Array<{ file: string; error: string }> = [];

  // Step 1: Fetch schemas (or use provided source)
  let schemas: Map<string, Buffer>;
  if (opts.schemaSource) {
    schemas = opts.schemaSource;
    log(`Using provided schema source with ${schemas.size} schemas`);
  } else {
    log("Fetching schemas...");
    schemas = await config.fetchSchemas({ force: opts.force });
    log(`Fetched ${schemas.size} schemas`);
  }

  // Step 2: Augment schemas (patches, overlays, etc.)
  let extraResults: T[] = [];
  if (config.augmentSchemas && !opts.schemaSource) {
    const augment = await config.augmentSchemas(schemas, opts, log);
    schemas = augment.schemas;
    if (augment.extraResults) extraResults = augment.extraResults;
    if (augment.warnings) warnings.push(...augment.warnings);
  }

  // Step 3: Parse each schema
  log("Parsing schemas...");
  const results: T[] = [];
  for (const [typeName, data] of schemas) {
    try {
      const result = config.parseSchema(typeName, data);
      if (result) results.push(result);
    } catch (err) {
      warnings.push({
        file: typeName,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  results.push(...extraResults);
  log(`Parsed ${results.length} schemas`);

  // Step 4: Augment results (fallbacks, synthetic resources, etc.)
  if (config.augmentResults) {
    const augment = config.augmentResults(results, opts, log);
    // augmentResults may mutate results in-place or return new ones
    if (augment.warnings) warnings.push(...augment.warnings);
  }

  // Step 5: Naming strategy
  const naming = config.createNaming(results);

  // Step 6: Generate artifacts
  log("Generating lexicon JSON...");
  const lexiconJSON = config.generateRegistry(results, naming);

  log("Generating TypeScript declarations...");
  const typesDTS = config.generateTypes(results, naming);

  log("Generating runtime index...");
  const indexTS = config.generateRuntimeIndex(results, naming);

  // Count stats
  let resourceCount = 0;
  let propertyCount = 0;
  let enumCount = 0;
  for (const r of results) {
    resourceCount++;
    propertyCount += r.propertyTypes.length;
    enumCount += r.enums.length;
  }

  return {
    lexiconJSON,
    typesDTS,
    indexTS,
    resources: resourceCount,
    properties: propertyCount,
    enums: enumCount,
    warnings,
  };
}

// ── Artifact writing ───────────────────────────────────────────────

export interface WriteConfig {
  /** Base directory of the lexicon package. */
  baseDir: string;
  /** Subdirectory for generated files (default: "src/generated"). */
  generatedSubdir?: string;
  /** Map of filename → content to write. */
  files: Record<string, string>;
}

/**
 * Write generated artifacts to disk.
 */
export function writeGeneratedArtifacts(config: WriteConfig): void {
  const generatedDir = join(config.baseDir, config.generatedSubdir ?? "src/generated");
  mkdirSync(generatedDir, { recursive: true });

  for (const [filename, content] of Object.entries(config.files)) {
    writeFileSync(join(generatedDir, filename), content);
  }
}
