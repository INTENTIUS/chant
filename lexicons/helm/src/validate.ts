/**
 * Validate generated lexicon-helm artifacts.
 *
 * Thin wrapper around the core validation framework
 * with Helm-specific configuration.
 */

import { dirname } from "path";
import { fileURLToPath } from "url";
import { validateLexiconArtifacts, type ValidateResult } from "@intentius/chant/codegen/validate";

export type { ValidateCheck, ValidateResult } from "@intentius/chant/codegen/validate";

const REQUIRED_NAMES = [
  "Chart",
  "Values",
  "HelmTest",
  "HelmNotes",
  "HelmHook",
  "HelmDependency",
  "HelmMaintainer",
];

/**
 * Validate the generated lexicon-helm artifacts.
 */
export async function validate(opts?: { basePath?: string }): Promise<ValidateResult> {
  const basePath = opts?.basePath ?? dirname(dirname(fileURLToPath(import.meta.url)));

  return validateLexiconArtifacts({
    lexiconJsonFilename: "lexicon-helm.json",
    requiredNames: REQUIRED_NAMES,
    basePath,
  });
}
