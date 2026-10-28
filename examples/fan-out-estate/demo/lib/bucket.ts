/**
 * The bucket, for real: `chant-demo` in the stack's floci, path-style S3 over
 * http. It is the e2e harness's FlociBucket (chant#4587). floci takes
 * unsigned requests, so the driver needs no AWS CLI on the host. Readers get
 * the same objects with a plain GetObject.
 */
export { FlociBucket } from "../../../../packages/core/src/e2e-harness/bucket.js";
