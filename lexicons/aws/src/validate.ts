/**
 * Validate generated lexicon-aws artifacts.
 *
 * Thin wrapper around the core validation framework
 * with AWS-specific configuration.
 */

import { dirname } from "path";
import { fileURLToPath } from "url";
import { validateLexiconArtifacts, type ValidateResult } from "@intentius/chant/codegen/validate";

export type { ValidateCheck, ValidateResult } from "@intentius/chant/codegen/validate";

const REQUIRED_NAMES = ["Bucket", "Function", "Role", "Table", "Policy", "LogGroup"];

/**
 * Validate the generated lexicon-aws artifacts.
 *
 * @param opts.basePath - Override the package directory (defaults to lexicon-aws package root)
 */
export async function validate(opts?: { basePath?: string }): Promise<ValidateResult> {
  const basePath = opts?.basePath ?? dirname(dirname(fileURLToPath(import.meta.url)));

  return validateLexiconArtifacts({
    lexiconJsonFilename: "lexicon-aws.json",
    requiredNames: REQUIRED_NAMES,
    basePath,
    coverageThresholds: {
      minPropertyPct: 1,
      minLifecyclePct: 1,
      minAttrPct: 1,
    },
  });
}
