/**
 * Validate generated lexicon-k3s artifacts.
 *
 * Thin wrapper around the core validation framework
 * with k3s-specific configuration.
 */

import { dirname } from "path";
import { fileURLToPath } from "url";
import { validateLexiconArtifacts, type ValidateResult } from "@intentius/chant/codegen/validate";

export type { ValidateCheck, ValidateResult } from "@intentius/chant/codegen/validate";

/**
 * Every entity class, plus load-bearing config keys whose disappearance
 * from a regeneration would mean the parser silently lost part of the
 * flag surface (#1599): the join/identity block, the etcd S3 keys the
 * lint layer references, and one representative per flag type.
 */
const REQUIRED_NAMES: string[] = [
  "Server",
  "Agent",
  "Registries",
  "Mirror",
  "RegistryConfig",
  "RegistryAuth",
  "RegistryTLS",
];

/**
 * Validate the generated lexicon-k3s artifacts.
 */
export async function validate(opts?: { basePath?: string }): Promise<ValidateResult> {
  const basePath = opts?.basePath ?? dirname(dirname(fileURLToPath(import.meta.url)));

  return validateLexiconArtifacts({
    lexiconJsonFilename: "lexicon-k3s.json",
    requiredNames: REQUIRED_NAMES,
    basePath,
  });
}
