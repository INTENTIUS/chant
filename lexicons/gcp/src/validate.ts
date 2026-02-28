/**
 * Validate generated lexicon-gcp artifacts.
 */

import { dirname } from "path";
import { fileURLToPath } from "url";
import { validateLexiconArtifacts, type ValidateResult } from "@intentius/chant/codegen/validate";

export type { ValidateCheck, ValidateResult } from "@intentius/chant/codegen/validate";

const REQUIRED_NAMES = [
  "ComputeInstance", "StorageBucket", "GKECluster", "SQLInstance",
  "GCPServiceAccount", "IAMPolicyMember", "CloudRunService", "PubSubTopic",
  "VPCNetwork",
];

export async function validate(opts?: { basePath?: string }): Promise<ValidateResult> {
  const basePath = opts?.basePath ?? dirname(dirname(fileURLToPath(import.meta.url)));

  return validateLexiconArtifacts({
    lexiconJsonFilename: "lexicon-gcp.json",
    requiredNames: REQUIRED_NAMES,
    basePath,
    coverageThresholds: {
      minPropertyPct: 0,
      minLifecyclePct: 0,
      minAttrPct: 1,
    },
  });
}
