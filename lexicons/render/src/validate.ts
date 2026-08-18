/**
 * Validate generated lexicon-render artifacts.
 *
 * Thin wrapper around the core validation framework with render-specific
 * configuration.
 */

import { dirname } from "path";
import { fileURLToPath } from "url";
import { validateLexiconArtifacts, type ValidateResult } from "@intentius/chant/codegen/validate";

export type { ValidateCheck, ValidateResult } from "@intentius/chant/codegen/validate";

/**
 * The curated top-level Render resources. A regeneration that loses one — an
 * upstream rename, a spec fetch that returned a partial document — must fail
 * validation rather than ship a lexicon missing a kind.
 */
const REQUIRED_NAMES: string[] = [
  "WebService",
  "StaticSite",
  "PrivateService",
  "BackgroundWorker",
  "CronJob",
  "Postgres",
  "KeyValue",
  "EnvGroup",
  "Project",
  "Environment",
  "Disk",
  "CustomDomain",
  "RegistryCredential",
  "Webhook",
];

/**
 * Validate the generated lexicon-render artifacts.
 */
export async function validate(opts?: { basePath?: string }): Promise<ValidateResult> {
  const basePath = opts?.basePath ?? dirname(dirname(fileURLToPath(import.meta.url)));

  return validateLexiconArtifacts({
    lexiconJsonFilename: "lexicon-render.json",
    requiredNames: REQUIRED_NAMES,
    basePath,
  });
}
