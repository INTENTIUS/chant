/**
 * `azureCapabilityPlugin`: the azure lexicon's capability plugin (#4273). It
 * contributes `arm-deploy` through core's `CapabilityPlugin` contract, so a
 * project declaring `lexicons: ["azure"]` gets the verb registered when it
 * runs components, the way the aws lexicon contributes `cfn-deploy`.
 */
import type { Capability } from "@intentius/chant/components/capability";
import { ownPackageVersion, type CapabilityPlugin } from "@intentius/chant/components/capability-plugin";
import { armDeployCapability } from "./arm-deploy";

export const AZURE_VERB_FAMILIES = {
  apply: ["arm-deploy"],
} as const;

export const azureCapabilityPlugin: CapabilityPlugin = {
  name: "azure",
  get version(): string {
    return ownPackageVersion(import.meta.url);
  },
  capabilities(): Array<Capability<never, unknown>> {
    return [armDeployCapability as Capability<never, unknown>];
  },
  families(): Record<string, readonly string[]> {
    return AZURE_VERB_FAMILIES;
  },
};
