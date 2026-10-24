/**
 * `gcpCapabilityPlugin`: the gcp lexicon's capability plugin (#4273). Core
 * loads it when a project's `chant.config.ts` lists `lexicons: ["gcp"]`, so a
 * component's `gcp-apply` step resolves, plans in `chant components pr-plan`
 * and runs.
 */

import type { Capability } from "@intentius/chant/components/capability";
import { ownPackageVersion, type CapabilityPlugin } from "@intentius/chant/components/capability-plugin";
import { gcpApplyCapability } from "./gcp-apply";
import { waitForOperationCapability, waitCloudRunReadyCapability } from "./wait-gcp";
import { artifactRegistryBackend } from "./artifact-registry-backend";

/** The GCP verb families this plugin contributes. */
export const GCP_VERB_FAMILIES = {
  apply: ["gcp-apply"],
  waitVerify: ["wait-for-operation", "wait-cloud-run-ready"],
  // `publish-image` is core's verb; gcp contributes the "artifact-registry" login backend.
} as const;

/** The gcp lexicon's capability plugin. */
export const gcpCapabilityPlugin: CapabilityPlugin = {
  name: "gcp",
  get version(): string {
    return ownPackageVersion(import.meta.url);
  },
  capabilities: () =>
    [gcpApplyCapability, waitForOperationCapability, waitCloudRunReadyCapability] as unknown as Array<Capability<never, unknown>>,
  registryBackends: () => [artifactRegistryBackend],
  families: () => GCP_VERB_FAMILIES,
};
