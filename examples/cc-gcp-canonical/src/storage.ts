import { StorageBucket } from "@intentius/chant-lexicon-gcp";

// The drift target: `storageClass` is the field the CC e2e edits out of band
// (test/gcp-cc-e2e.sh, the edit #1582's acceptance proved). Deliberately no
// `uniformBucketLevelAccess` — floci-gcp drops `iamConfiguration` on insert
// (test/floci-gaps.md entry 6), so declaring it would put one honest `absent`
// drift on every clean apply.
export const assets = new StorageBucket({
  metadata: { name: "cc-gcp-assets" },
  location: "US",
  storageClass: "STANDARD",
});
