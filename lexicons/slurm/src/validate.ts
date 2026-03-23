/**
 * Validate generated lexicon-slurm artifacts.
 *
 * Thin wrapper around the core validation framework
 * with slurm-specific configuration.
 */

import { dirname } from "path";
import { fileURLToPath } from "url";
import { validateLexiconArtifacts, type ValidateResult } from "@intentius/chant/codegen/validate";

export type { ValidateCheck, ValidateResult } from "@intentius/chant/codegen/validate";

// TODO: Add names of required entities for your lexicon
const REQUIRED_NAMES: string[] = [];

/**
 * Validate the generated lexicon-slurm artifacts.
 */
export async function validate(opts?: { basePath?: string }): Promise<ValidateResult> {
  const basePath = opts?.basePath ?? dirname(dirname(fileURLToPath(import.meta.url)));

  return validateLexiconArtifacts({
    lexiconJsonFilename: "lexicon-slurm.json",
    requiredNames: REQUIRED_NAMES,
    basePath,
  });
}
