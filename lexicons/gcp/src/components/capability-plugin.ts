/**
 * `gcpCapabilityPlugin`: the gcp lexicon's capability plugin (#4273). Core
 * loads it when a project's `chant.config.ts` lists `lexicons: ["gcp"]`, so a
 * component's `gcp-apply` step resolves, plans in `chant components pr-plan`
 * and runs.
 */

import type { Capability } from "@intentius/chant/components/capability";
import { ownPackageVersion, type CapabilityPlugin } from "@intentius/chant/components/capability-plugin";
import { gcpApplyCapability } from "./gcp-apply";

/** The GCP verb families this plugin contributes. */
export const GCP_VERB_FAMILIES = {
  apply: ["gcp-apply"],
} as const;

/** The gcp lexicon's capability plugin. */
export const gcpCapabilityPlugin: CapabilityPlugin = {
  name: "gcp",
  get version(): string {
    return ownPackageVersion(import.meta.url);
  },
  capabilities: () => [gcpApplyCapability] as unknown as Array<Capability<never, unknown>>,
  families: () => GCP_VERB_FAMILIES,
};
