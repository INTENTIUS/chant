/**
 * Validate generated lexicon-gitlab artifacts.
 *
 * Thin wrapper around the core validation framework
 * with GitLab-specific configuration.
 */

import { dirname } from "path";
import { fileURLToPath } from "url";
import { validateLexiconArtifacts, type ValidateResult } from "@intentius/chant/codegen/validate";

export type { ValidateCheck, ValidateResult } from "@intentius/chant/codegen/validate";

const REQUIRED_NAMES = [
  "Job", "Default", "Workflow",
  "Artifacts", "Cache", "Image", "Service", "Rule", "Retry",
  "AllowFailure", "Parallel", "Include", "Release",
  "Environment", "Trigger", "AutoCancel",
];

/**
 * Validate the generated lexicon-gitlab artifacts.
 *
 * @param opts.basePath - Override the package directory (defaults to lexicon-gitlab package root)
 */
export async function validate(opts?: { basePath?: string }): Promise<ValidateResult> {
  const basePath = opts?.basePath ?? dirname(dirname(fileURLToPath(import.meta.url)));

  return validateLexiconArtifacts({
    lexiconJsonFilename: "lexicon-gitlab.json",
    requiredNames: REQUIRED_NAMES,
    basePath,
  });
}
