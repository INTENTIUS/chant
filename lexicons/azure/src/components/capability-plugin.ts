/**
 * `azureCapabilityPlugin`: the azure lexicon's capability plugin (#4273). It
 * contributes `arm-deploy` through core's `CapabilityPlugin` contract, so a
 * project declaring `lexicons: ["azure"]` gets the verb registered when it
 * runs components, the way the aws lexicon contributes `cfn-deploy`.
 */
import type { Capability } from "@intentius/chant/components/capability";
import { ownPackageVersion, type CapabilityPlugin } from "@intentius/chant/components/capability-plugin";
import { armDeployCapability } from "./arm-deploy";
import { waitForDeploymentCapability, waitContainerAppCapability } from "./wait-azure";
import { acrRegistryBackend } from "./acr-backend";
import { azureBlobStorageBackend } from "./blob-backend";

export const AZURE_VERB_FAMILIES = {
  apply: ["arm-deploy"],
  waitVerify: ["wait-for-deployment", "wait-container-app"],
  // `publish-image` is core's verb; azure contributes the "acr" registry login backend.
} as const;

export const azureCapabilityPlugin: CapabilityPlugin = {
  name: "azure",
  get version(): string {
    return ownPackageVersion(import.meta.url);
  },
  capabilities(): Array<Capability<never, unknown>> {
    return [
      armDeployCapability,
      waitForDeploymentCapability,
      waitContainerAppCapability,
    ] as unknown as Array<Capability<never, unknown>>;
  },
  registryBackends() {
    return [acrRegistryBackend];
  },
  storageBackends() {
    return [azureBlobStorageBackend];
  },
  families(): Record<string, readonly string[]> {
    return AZURE_VERB_FAMILIES;
  },
};
