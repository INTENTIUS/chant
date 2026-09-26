/**
 * Validate generated lexicon-systemone artifacts.
 *
 * Thin wrapper around the core validation framework
 * with systemone-specific configuration.
 */

import { dirname } from "path";
import { fileURLToPath } from "url";
import { validateLexiconArtifacts, type ValidateResult } from "@intentius/chant/codegen/validate";

export type { ValidateCheck, ValidateResult } from "@intentius/chant/codegen/validate";

// The lexicon declares no resources, so no generated name is required.
const REQUIRED_NAMES: string[] = [];

/**
 * Validate the generated lexicon-systemone artifacts.
 */
export async function validate(opts?: { basePath?: string }): Promise<ValidateResult> {
  const basePath = opts?.basePath ?? dirname(dirname(fileURLToPath(import.meta.url)));

  return validateLexiconArtifacts({
    lexiconJsonFilename: "lexicon-systemone.json",
    requiredNames: REQUIRED_NAMES,
    basePath,
  });
}
