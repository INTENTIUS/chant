import { GCPServiceAccount, SecretManagerSecret } from "@intentius/chant-lexicon-gcp";

// The second drift probe: `displayName` is human-editable in the console and
// carries no semantics, which makes it the safest field to mutate out of band.
export const probeSa = new GCPServiceAccount({
  metadata: { name: "cc-gcp-probe" },
  displayName: "CC probe SA",
});

export const apiKey = new SecretManagerSecret({
  metadata: { name: "cc-gcp-api-key" },
  replication: { automatic: true },
});
