/**
 * Schema-driven code generation for the cedar lexicon (#1650).
 *
 * The pipeline is core's; what is unusual is its input. Every other lexicon
 * fetches one global upstream spec, so `fetchSchemas` is an HTTP call and a
 * cache. Cedar's spec-of-interest is the project's own `.cedarschema` (epic
 * #1645), so `fetchSchemas` is a file read with a fallback, and the pinned
 * upstream is the *grammar* — `@cedar-policy/cedar-wasm`, whose language
 * version is asserted before anything is emitted.
 *
 * Order matters in {@link generate}: the language-version assert runs before
 * the schema is resolved, because resolution is the thing whose output shape a
 * grammar change would move.
 */

import { generatePipeline, writeGeneratedArtifacts } from "@intentius/chant/codegen/generate";
import type { GenerateOptions, GenerateResult } from "@intentius/chant/codegen/generate";
import type { NamingStrategy } from "@intentius/chant/codegen/naming";
import { dirname } from "path";
import { fileURLToPath } from "url";
import { createNaming } from "./naming";
import {
  buildEmitModel,
  generateRegistry,
  generateRuntimeIndex,
  generateTypes,
  RUNTIME_TS,
  type EmitModel,
} from "./emit";
import { DEFAULT_SCHEMA_KEY, fetchSchemas, resolveSchemaPath } from "../spec/fetch";
import { parseCedarSchema, type CedarDecl } from "../spec/parse";
import { assertPinnedLangVersion, assertPinnedSchema } from "../spec/pin";

/** Filename of the generated registry. */
export const LEXICON_JSON_FILENAME = "lexicon-cedar.json";

export interface CedarGenerateOptions extends GenerateOptions {
  /** Project root the `cedar.schema` path is resolved against. Defaults to `process.cwd()`. */
  projectRoot?: string;
  /** The `cedar` config namespace, when the caller has already loaded it. */
  config?: { schema?: string; validation?: { requireProjectSchema?: boolean } };
}

/**
 * Run the code generation pipeline.
 */
export async function generate(options: CedarGenerateOptions = {}): Promise<GenerateResult> {
  // Refuse a grammar nobody chose before reading anything (#1390's rule).
  assertPinnedLangVersion();

  // The three emit callbacks each need the same model, and the pipeline hands
  // them the results separately. Memoizing on the results array keeps one
  // build per run without a mutable `let` whose assignment TypeScript cannot
  // see happening inside a callback.
  const models = new Map<readonly CedarDecl[], EmitModel>();
  const modelFor = (results: CedarDecl[], naming: NamingStrategy): EmitModel => {
    const cached = models.get(results);
    if (cached) return cached;
    const built = buildEmitModel(results, naming);
    models.set(results, built);
    return built;
  };

  const result = await generatePipeline<CedarDecl>(
    {
      fetchSchemas: () => fetchSchemas({ projectRoot: options.projectRoot, config: options.config }),

      parseSchema: (typeName, data) => {
        const { decls, resolved } = parseCedarSchema(data.toString("utf-8"));

        // The content pin covers the schema this package ships, not a user's.
        // Theirs is their input; its churn is theirs to own.
        if (typeName === DEFAULT_SCHEMA_KEY) {
          assertPinnedSchema(
            resolved,
            decls.map((d) => d.typeName).sort(),
          );
        }

        return decls;
      },

      createNaming: (results) => createNaming(results),

      generateRegistry: (results, naming) => generateRegistry(modelFor(results, naming)),

      generateTypes: (results, naming) => generateTypes(modelFor(results, naming)),

      generateRuntimeIndex: (results, naming) => generateRuntimeIndex(modelFor(results, naming)),

      generateExtraArtifacts: () => ({ "runtime.ts": RUNTIME_TS }),
    },
    options,
  );

  if (options.verbose) {
    const source = resolveSchemaPath({ projectRoot: options.projectRoot, config: options.config });
    console.error(
      `Generated ${result.resources} declaration(s) from ` +
        `${source.isDefault ? "the bundled default schema" : source.path}`,
    );
  }

  return result;
}

/**
 * Write generated files to the package directory.
 */
export function writeGeneratedFiles(result: GenerateResult, pkgDir?: string): void {
  // This module lives at <pkg>/src/codegen/generate.ts, so the package root is
  // three levels up — the scaffold's two-level default wrote into src/src/.
  const dir = pkgDir ?? dirname(dirname(dirname(fileURLToPath(import.meta.url))));
  writeGeneratedArtifacts({
    baseDir: dir,
    files: {
      [LEXICON_JSON_FILENAME]: result.lexiconJSON,
      "index.d.ts": result.typesDTS,
      "index.ts": result.indexTS,
      ...(result.extraArtifacts ?? {}),
    },
  });
}
