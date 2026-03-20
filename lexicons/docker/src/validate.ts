/**
 * Validate generated lexicon-docker artifacts.
 */

import { dirname, join } from "path";
import { existsSync } from "fs";
import { fileURLToPath } from "url";
import { validateLexiconArtifacts, type ValidateResult } from "@intentius/chant/codegen/validate";

export type { ValidateCheck, ValidateResult } from "@intentius/chant/codegen/validate";

const REQUIRED_NAMES = [
  "Service",
  "Volume",
  "Network",
  "DockerConfig",
  "DockerSecret",
  "Dockerfile",
];

/**
 * Validate the generated lexicon-docker artifacts.
 */
export async function validate(opts?: { basePath?: string }): Promise<ValidateResult> {
  const basePath = opts?.basePath ?? dirname(dirname(fileURLToPath(import.meta.url)));
  const generatedDir = join(basePath, "src", "generated");

  if (!existsSync(generatedDir)) {
    return {
      success: false,
      checks: [{
        name: "generated-dir",
        ok: false,
        error: 'src/generated/ not found — run "chant dev generate" first',
      }],
    };
  }

  return validateLexiconArtifacts({
    lexiconJsonFilename: "lexicon-docker.json",
    requiredNames: REQUIRED_NAMES,
    basePath,
  });
}
