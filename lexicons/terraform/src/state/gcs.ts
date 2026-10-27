/**
 * The Google Cloud Storage client a gcs backend's state uses: chant core's
 * (#4554, `@intentius/chant/object-store`), over the JSON API with `fetch`
 * and `node:crypto`. Writes are conditional on a generation
 * (`ifGenerationMatch`); a lost write is a 412, a StoreConflict.
 */
export { GCS_ENDPOINT, GcsClient, IAM_CREDENTIALS, selfSignedJwt, type GcsTarget } from "@intentius/chant/object-store";
