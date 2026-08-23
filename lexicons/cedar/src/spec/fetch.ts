/**
 * "Fetch" the Cedar schema — which for this lexicon means reading a file.
 *
 * Every other lexicon downloads one global upstream spec. Cedar's interesting
 * spec is the *project's* schema (epic #1645), so there is nothing to fetch,
 * nothing to cache, and no network at all. What replaces it is a small
 * resolution order:
 *
 *   1. `cedar.schema` from the project's `chant.config.ts`
 *   2. `schema.cedarschema` in the project root
 *   3. the schema bundled at `./default-schema.cedarschema`
 *
 * Step 3 is the one that needs defending. Without it `generate()` has nothing
 * to read in a checkout that has not written a schema yet — which is every
 * fresh clone, `just check-lexicons`, and this lexicon's own examples — and a
 * lexicon whose generate step only works after the user does something is a
 * lexicon whose generate step is never gated. The default is a real
 * application-authorization schema, not a stub, so the surface it produces is
 * worth exercising.
 *
 * `requireProjectSchema` turns step 3 off for projects that have moved past it.
 */

import { existsSync, readFileSync } from "fs";
import { dirname, isAbsolute, join, resolve } from "path";
import { fileURLToPath } from "url";
import { CEDAR_DEFAULT_SCHEMA_PATH } from "../config";

/** Filename the bundled fallback schema ships under. */
export const DEFAULT_SCHEMA_FILENAME = "default-schema.cedarschema";

/** Map key used for the single schema entry, so `parseSchema` can tell them apart. */
export const DEFAULT_SCHEMA_KEY = "<bundled-default>";

let specDir: string | undefined;

/**
 * Directory this module lives in, resolved on first use.
 *
 * Kept lazy so importing the module never touches `import.meta.url`; edge
 * bundles that pull this file in through the lint barrel have no such URL and
 * would crash at module init otherwise.
 */
function resolveSpecDir(): string | undefined {
  if (specDir !== undefined) return specDir;
  try {
    specDir = dirname(fileURLToPath(import.meta.url));
  } catch {
    return undefined;
  }
  return specDir;
}

/** Absolute path to the schema bundled with this package. */
export function defaultSchemaPath(): string {
  const dir = resolveSpecDir();
  if (dir === undefined) {
    throw new Error("cedar: the bundled default schema is not reachable from this runtime (no module URL).");
  }
  return join(dir, DEFAULT_SCHEMA_FILENAME);
}

export interface SchemaSource {
  /** Absolute path the text came from. */
  path: string;
  /** The `.cedarschema` text. */
  text: string;
  /** True when the bundled fallback was used rather than a project schema. */
  isDefault: boolean;
}

export interface ResolveSchemaOptions {
  /** Project root to resolve a relative `cedar.schema` against. Defaults to `process.cwd()`. */
  projectRoot?: string;
  /** Already-loaded `cedar` config namespace, if the caller has one. */
  config?: { schema?: string; validation?: { requireProjectSchema?: boolean } };
}

/**
 * Resolve which schema `generate()` should read, without loading it.
 *
 * Separated from {@link fetchSchemas} so tests and `coverage()` can ask the
 * question without reading the file.
 */
export function resolveSchemaPath(options: ResolveSchemaOptions = {}): { path: string; isDefault: boolean } {
  const root = options.projectRoot ?? process.cwd();
  const configured = options.config?.schema;

  const candidates = configured
    ? [isAbsolute(configured) ? configured : resolve(root, configured)]
    : [resolve(root, CEDAR_DEFAULT_SCHEMA_PATH)];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return { path: candidate, isDefault: false };
  }

  if (options.config?.validation?.requireProjectSchema) {
    throw new Error(
      `cedar: no schema found at ${candidates.join(", ")}. ` +
        "`cedar.validation.requireProjectSchema` is on, so the bundled default schema is not used.",
    );
  }

  return { path: defaultSchemaPath(), isDefault: true };
}

/** Read the resolved schema. */
export function readSchemaSource(options: ResolveSchemaOptions = {}): SchemaSource {
  const { path, isDefault } = resolveSchemaPath(options);
  return { path, text: readFileSync(path, "utf-8"), isDefault };
}

/**
 * The `fetchSchemas` callback for `generatePipeline`.
 *
 * Keyed by `<bundled-default>` or by the project schema's absolute path, which
 * is how `parseSchema` knows whether the content pin applies.
 */
export async function fetchSchemas(options?: {
  force?: boolean;
  projectRoot?: string;
  config?: ResolveSchemaOptions["config"];
}): Promise<Map<string, Buffer>> {
  const source = readSchemaSource({ projectRoot: options?.projectRoot, config: options?.config });
  return new Map([
    [source.isDefault ? DEFAULT_SCHEMA_KEY : source.path, Buffer.from(source.text, "utf-8")],
  ]);
}
