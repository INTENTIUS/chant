/**
 * The azure lexicon's registry login for core's `publish-image` (#3142): ACR,
 * through `az acr login`. Core owns load, tag, push and the digest read-back;
 * this only authenticates the local docker client.
 */
import type { RegistryLoginBackend } from "@intentius/chant/components/verbs/publish-image";
import { defaultProcessRunner, q, type ProcessRunner } from "@intentius/chant/components/verbs/process-runner";

/** `<name>.azurecr.io` (also the sovereign-cloud suffixes). */
const ACR_HOST = /^([a-z0-9]+)\.azurecr\.(io|cn|us)$/i;

export function createAcrRegistryBackend(runner?: ProcessRunner): RegistryLoginBackend {
  return {
    name: "acr",
    matches: (registry) => ACR_HOST.test(registry),
    async login(registry) {
      const m = ACR_HOST.exec(registry);
      if (!m) throw new Error(`acr login: "${registry}" is not an Azure Container Registry host (<name>.azurecr.io)`);
      await (runner ?? defaultProcessRunner()).run(`az acr login --name ${q(m[1]!)}`);
    },
  };
}

/** The ACR backend the azure plugin contributes, over the real process runner. */
export const acrRegistryBackend: RegistryLoginBackend = createAcrRegistryBackend();
