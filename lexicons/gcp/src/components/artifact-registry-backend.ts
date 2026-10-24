/**
 * The gcp lexicon's registry login for core's `publish-image` (#3143):
 * Artifact Registry (and the legacy gcr.io hosts), through
 * `gcloud auth configure-docker`. Core owns load, tag, push and the digest
 * read-back; this only authenticates the local docker client.
 */
import type { RegistryLoginBackend } from "@intentius/chant/components/verbs/publish-image";
import { defaultProcessRunner, q, type ProcessRunner } from "@intentius/chant/components/verbs/process-runner";

/** `<region>-docker.pkg.dev`, `gcr.io` and its `<geo>.gcr.io` forms. */
const AR_HOST = /^([a-z0-9-]+-docker\.pkg\.dev|([a-z]+\.)?gcr\.io)$/i;

export function createArtifactRegistryBackend(runner?: ProcessRunner): RegistryLoginBackend {
  return {
    name: "artifact-registry",
    matches: (registry) => AR_HOST.test(registry),
    async login(registry) {
      if (!AR_HOST.test(registry)) {
        throw new Error(`artifact-registry login: "${registry}" is not an Artifact Registry host (<region>-docker.pkg.dev)`);
      }
      await (runner ?? defaultProcessRunner()).run(`gcloud auth configure-docker ${q(registry)} --quiet`);
    },
  };
}

/** The Artifact Registry backend the gcp plugin contributes, over the real process runner. */
export const artifactRegistryBackend: RegistryLoginBackend = createArtifactRegistryBackend();
