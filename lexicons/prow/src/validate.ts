/**
 * Validate generated lexicon-prow artifacts.
 *
 * Thin wrapper around the core validation framework
 * with prow-specific configuration.
 */

import { dirname } from "path";
import { fileURLToPath } from "url";
import { validateLexiconArtifacts, type ValidateResult } from "@intentius/chant/codegen/validate";

export type { ValidateCheck, ValidateResult } from "@intentius/chant/codegen/validate";

/** The job kinds and the types a job's pod spec is made of. */
const REQUIRED_NAMES: string[] = [
  "Presubmit",
  "Postsubmit",
  "Periodic",
  "JobConfig",
  "PodSpec",
  "Container",
  "EnvVar",
  "EnvFromSource",
  "Volume",
  "VolumeMount",
  "ResourceRequirements",
  "SecurityContext",
  "Toleration",
  "DecorationConfig",
  "Refs",
  "ReporterConfig",
  "RerunAuthConfig",
  "ProwJobDefault",
  "Retry",
  "JenkinsSpec",
  "PipelineRunSpec",
  "TektonPipelineRunSpec",
];

/**
 * Validate the generated lexicon-prow artifacts.
 */
export async function validate(opts?: { basePath?: string }): Promise<ValidateResult> {
  const basePath = opts?.basePath ?? dirname(dirname(fileURLToPath(import.meta.url)));

  return validateLexiconArtifacts({
    lexiconJsonFilename: "lexicon-prow.json",
    requiredNames: REQUIRED_NAMES,
    basePath,
  });
}
