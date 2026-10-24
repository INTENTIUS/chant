/**
 * The azure lexicon's storage backend for core's `publish-artifact` (#4408):
 * Azure Blob Storage through `az storage blob upload`. Core owns the content
 * digest and the object URI; this only uploads.
 */
import type { ArtifactStorageBackend } from "@intentius/chant/components/verbs/publish-artifact";
import { defaultProcessRunner, q, type ProcessRunner } from "@intentius/chant/components/verbs/process-runner";

/** `https://<account>.blob.core.windows.net/<container>/<blob path>` (also the sovereign-cloud suffixes). */
const BLOB_URI = /^https:\/\/([a-z0-9]+)\.blob\.core\.(windows\.net|chinacloudapi\.cn|usgovcloudapi\.net)\/([^/]+)\/(.+)$/i;

export function createAzureBlobStorageBackend(runner?: ProcessRunner): ArtifactStorageBackend {
  return {
    name: "azure-blob",
    matches: (uri) => /^https:\/\/[a-z0-9]+\.blob\.core\./i.test(uri),
    async upload({ from, to }) {
      const m = BLOB_URI.exec(to);
      if (!m) {
        throw new Error(`azure-blob upload: "${to}" is not a blob URI (https://<account>.blob.core.windows.net/<container>/<path>)`);
      }
      await (runner ?? defaultProcessRunner()).run(
        `az storage blob upload --account-name ${q(m[1]!)} --container-name ${q(m[3]!)} --name ${q(m[4]!)} --file ${q(from)} --overwrite --auth-mode login`,
      );
    },
  };
}

/** The Blob backend the azure plugin contributes, over the real process runner. */
export const azureBlobStorageBackend: ArtifactStorageBackend = createAzureBlobStorageBackend();
