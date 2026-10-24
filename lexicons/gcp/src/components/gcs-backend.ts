/**
 * The gcp lexicon's storage backend for core's `publish-artifact` (#4408):
 * Google Cloud Storage through `gcloud storage cp`. Core owns the content
 * digest and the object URI; this only uploads.
 */
import type { ArtifactStorageBackend } from "@intentius/chant/components/verbs/publish-artifact";
import { defaultProcessRunner, q, type ProcessRunner } from "@intentius/chant/components/verbs/process-runner";

export function createGcsStorageBackend(runner?: ProcessRunner): ArtifactStorageBackend {
  return {
    name: "gcs",
    matches: (uri) => uri.startsWith("gs://"),
    async upload({ from, to }) {
      if (!/^gs:\/\/[^/]+\/.+/.test(to)) {
        throw new Error(`gcs upload: "${to}" is not an object URI (gs://<bucket>/<path>)`);
      }
      await (runner ?? defaultProcessRunner()).run(`gcloud storage cp ${q(from)} ${q(to)}`);
    },
  };
}

/** The GCS backend the gcp plugin contributes, over the real process runner. */
export const gcsStorageBackend: ArtifactStorageBackend = createGcsStorageBackend();
