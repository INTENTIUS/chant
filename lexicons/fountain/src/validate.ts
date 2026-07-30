/**
 * Validate generated lexicon-fountain artifacts.
 *
 * Thin wrapper around the core validation framework
 * with fountain-specific configuration.
 */

import { dirname } from "path";
import { fileURLToPath } from "url";
import { validateLexiconArtifacts, type ValidateResult } from "@intentius/chant/codegen/validate";

export type { ValidateCheck, ValidateResult } from "@intentius/chant/codegen/validate";

/**
 * The curated surface, as named in spec/parse.ts. A regeneration that
 * loses one — an upstream rename, a spec fetch that returned a partial
 * document — must fail validation rather than ship a lexicon missing a
 * kind. Repository is included: it is the one property type reachable
 * from the request schemas, and its absence means ref-following broke.
 */
const REQUIRED_NAMES: string[] = ["Environment", "Vault", "Agent", "Repository"];

/**
 * Validate the generated lexicon-fountain artifacts.
 */
export async function validate(opts?: { basePath?: string }): Promise<ValidateResult> {
  const basePath = opts?.basePath ?? dirname(dirname(fileURLToPath(import.meta.url)));

  return validateLexiconArtifacts({
    lexiconJsonFilename: "lexicon-fountain.json",
    requiredNames: REQUIRED_NAMES,
    basePath,
  });
}
