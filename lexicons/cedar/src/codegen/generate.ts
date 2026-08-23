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
import { existsSync, realpathSync } from "fs";
import { dirname, isAbsolute, resolve } from "path";
import { fileURLToPath } from "url";
import { CEDAR_DEFAULT_OUT_DIR } from "../config";
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

/** The slice of the `cedar` config namespace generation reads. */
export interface CedarGenerateConfig {
  schema?: string;
  outDir?: string;
  validation?: { requireProjectSchema?: boolean };
}

export interface CedarGenerateOptions extends GenerateOptions {
  /** Project root the `cedar.schema` path is resolved against. Defaults to `process.cwd()`. */
  projectRoot?: string;
  /** The `cedar` config namespace, when the caller has already loaded it. */
  config?: CedarGenerateConfig;
}

/** This package's root. `<pkg>/src/codegen/generate.ts` is three levels down. */
export function packageDir(): string {
  return dirname(dirname(dirname(fileURLToPath(import.meta.url))));
}

function samePath(a: string, b: string): boolean {
  const real = (p: string): string => (existsSync(p) ? realpathSync(p) : resolve(p));
  return real(a) === real(b);
}

/**
 * Where generated artifacts go (#1696).
 *
 * Three cases, in order:
 *
 *   1. `cedar.outDir` is set: that directory, resolved against the project root.
 *   2. The project root *is* this package (the monorepo checkout, `npm run
 *      generate`, `chant dev check-lexicon`): `<pkg>/src/generated`, which
 *      `src/index.ts` re-exports so the package's own surface stays whole.
 *   3. Anything else is a consumer: `<project>/src/generated/cedar`.
 *
 * Case 2 is what the old code assumed everywhere. A consumer's project root
 * and the installed package are different directories, and writing into the
 * second means the output is gone after `npm ci`.
 */
export function resolveGeneratedDir(options: { projectRoot?: string; config?: CedarGenerateConfig } = {}): string {
  const root = options.projectRoot ?? process.cwd();
  const configured = options.config?.outDir;
  if (configured) return isAbsolute(configured) ? configured : resolve(root, configured);

  const pkg = packageDir();
  if (samePath(root, pkg)) return resolve(pkg, "src", "generated");

  return resolve(root, CEDAR_DEFAULT_OUT_DIR);
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

/** The files one generate run produces, keyed by filename. */
export function generatedFiles(result: GenerateResult): Record<string, string> {
  return {
    [LEXICON_JSON_FILENAME]: result.lexiconJSON,
    "index.d.ts": result.typesDTS,
    "index.ts": result.indexTS,
    ...(result.extraArtifacts ?? {}),
  };
}

/**
 * Write generated files into `outDir`. With no directory given, writes where
 * {@link resolveGeneratedDir} says for the current working directory.
 */
export function writeGeneratedFiles(result: GenerateResult, outDir?: string): void {
  writeGeneratedArtifacts({
    baseDir: outDir ?? resolveGeneratedDir(),
    generatedSubdir: ".",
    files: generatedFiles(result),
  });
}
