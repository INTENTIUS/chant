/**
 * Validate generated lexicon-github artifacts.
 */

import { dirname } from "path";
import { fileURLToPath } from "url";
import { validateLexiconArtifacts, type ValidateResult } from "@intentius/chant/codegen/validate";

export type { ValidateCheck, ValidateResult } from "@intentius/chant/codegen/validate";

const REQUIRED_NAMES = [
  "Workflow", "Job", "ReusableWorkflowCallJob",
  "Step", "Strategy", "Permissions", "Concurrency",
  "Container", "Service", "Environment", "Defaults",
  "PushTrigger", "PullRequestTrigger", "PullRequestTargetTrigger",
  "ScheduleTrigger", "WorkflowDispatchTrigger", "WorkflowCallTrigger",
  "WorkflowRunTrigger", "RepositoryDispatchTrigger",
  "WorkflowInput", "WorkflowOutput", "WorkflowSecret",
];

/**
 * Validate the generated lexicon-github artifacts.
 */
export async function validate(opts?: { basePath?: string }): Promise<ValidateResult> {
  const basePath = opts?.basePath ?? dirname(dirname(fileURLToPath(import.meta.url)));

  return validateLexiconArtifacts({
    lexiconJsonFilename: "lexicon-github.json",
    requiredNames: REQUIRED_NAMES,
    basePath,
  });
}
