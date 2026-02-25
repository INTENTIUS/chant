/**
 * Validate generated Flyway lexicon artifacts.
 */

import { dirname } from "path";
import { fileURLToPath } from "url";
import { validateLexiconArtifacts, type ValidateResult } from "@intentius/chant/codegen/validate";

export type { ValidateCheck, ValidateResult } from "@intentius/chant/codegen/validate";

const REQUIRED_NAMES = [
  "FlywayProject",
  "FlywayConfig",
  "Environment",
  "EnvironmentFlyway",
  "VaultResolver",
  "GcpResolver",
  "DaprResolver",
  "CloneResolver",
  "AzureAdResolver",
  "EnvResolver",
  "GitResolver",
  "LocalSecretResolver",
  "BackupProvisioner",
  "SnapshotProvisioner",
  "CleanProvisioner",
  "CreateDbProvisioner",
  "DockerProvisioner",
  "FlywayDesktopConfig",
  "RedgateCompareConfig",
  "Placeholder",
];

/**
 * Validate the generated Flyway lexicon artifacts.
 */
export async function validate(opts?: { basePath?: string }): Promise<ValidateResult> {
  const basePath = opts?.basePath ?? dirname(dirname(fileURLToPath(import.meta.url)));

  return validateLexiconArtifacts({
    lexiconJsonFilename: "lexicon-flyway.json",
    requiredNames: REQUIRED_NAMES,
    basePath,
  });
}
