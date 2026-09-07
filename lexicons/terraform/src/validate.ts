/**
 * Validate generated lexicon-terraform artifacts.
 *
 * Thin wrapper around the core validation framework
 * with terraform-specific configuration.
 */

import { dirname } from "path";
import { fileURLToPath } from "url";
import { validateLexiconArtifacts, type ValidateResult } from "@intentius/chant/codegen/validate";

export type { ValidateCheck, ValidateResult } from "@intentius/chant/codegen/validate";

/**
 * Empty, and correct empty (#2220). `requiredNames` names generated resource
 * classes that must survive a regenerate, and this lexicon generates none:
 * `codegen/generate.ts` writes `lexicon-terraform.json` as `{}` on purpose,
 * because Terraform's resource surface lives in provider registries rather
 * than in one upstream schema, and an estate's `.tf` files are read as they
 * are. There is no name to require, so the list stays empty and the
 * remaining checks (the artifacts exist, the registry parses, the surface
 * snapshot) are what validate actually proves here.
 */
const REQUIRED_NAMES: string[] = [];

/**
 * Validate the generated lexicon-terraform artifacts.
 */
export async function validate(opts?: { basePath?: string }): Promise<ValidateResult> {
  const basePath = opts?.basePath ?? dirname(dirname(fileURLToPath(import.meta.url)));

  return validateLexiconArtifacts({
    lexiconJsonFilename: "lexicon-terraform.json",
    requiredNames: REQUIRED_NAMES,
    basePath,
  });
}
