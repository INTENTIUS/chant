// KMS encryption at rest: key ring + crypto key for CockroachDB backups and secrets.

import { KMSKeyRing, KMSCryptoKey } from "@intentius/chant-lexicon-gcp";

export const keyRing = new KMSKeyRing({
  metadata: { name: "crdb-multi-region" },
  location: "us",
});

export const cryptoKey = new KMSCryptoKey({
  metadata: { name: "crdb-encryption" },
  keyRingRef: { name: "crdb-multi-region" },
  purpose: "ENCRYPT_DECRYPT",
  rotationPeriod: "7776000s",
  versionTemplate: { algorithm: "GOOGLE_SYMMETRIC_ENCRYPTION" },
});
