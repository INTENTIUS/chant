import { KMSKeyRing, KMSCryptoKey } from "@intentius/chant-lexicon-gcp";
import { shared } from "../config";

export const keyRing = new KMSKeyRing({
  metadata: { name: "gitlab-cells" },
  location: shared.region,
});

export const cryptoKey = new KMSCryptoKey({
  metadata: { name: "gitlab-cells" },
  keyRingRef: { name: "gitlab-cells" },
  purpose: "ENCRYPT_DECRYPT",
  rotationPeriod: "7776000s",
  versionTemplate: { algorithm: "GOOGLE_SYMMETRIC_ENCRYPTION" },
});
