/**
 * Validate generated lexicon-fly artifacts.
 *
 * Thin wrapper around the core validation framework
 * with fly-specific configuration.
 */

import { dirname } from "path";
import { fileURLToPath } from "url";
import { validateLexiconArtifacts, type ValidateResult } from "@intentius/chant/codegen/validate";

export type { ValidateCheck, ValidateResult } from "@intentius/chant/codegen/validate";

/**
 * The curated top-level Machines API resources (#741). A regeneration that
 * loses one — an upstream rename, a spec fetch that returned a partial
 * document — must fail validation rather than ship a lexicon missing a kind.
 */
const REQUIRED_NAMES: string[] = [
  "App",
  "Machine",
  "Volume",
  "IPAddress",
  "Certificate",
  "Secret",
];

/**
 * Validate the generated lexicon-fly artifacts.
 */
export async function validate(opts?: { basePath?: string }): Promise<ValidateResult> {
  const basePath = opts?.basePath ?? dirname(dirname(fileURLToPath(import.meta.url)));

  return validateLexiconArtifacts({
    lexiconJsonFilename: "lexicon-fly.json",
    requiredNames: REQUIRED_NAMES,
    basePath,
  });
}
