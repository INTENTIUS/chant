// Encryption, backups and the WAF — shared by the three regions, owned by
// none of them. The TLS secrets are next door in ./secrets.ts.

import {
  KMSKeyRing,
  KMSCryptoKey,
  GcsBucket,
  IAMPolicyMember,
  SecurityPolicy,
} from "@intentius/chant-lexicon-gcp";
import {
  BACKUP_BUCKET,
  GCP_PROJECT_ID,
  GCP_PROJECT_NUMBER,
  KMS_CRYPTO_KEY,
  KMS_KEY_RING,
  WAF_POLICY,
} from "./config";

// ── Encryption at rest ─────────────────────────────────────────────

export const keyRing = new KMSKeyRing({
  metadata: { name: KMS_KEY_RING },
  location: "us",
});

export const cryptoKey = new KMSCryptoKey({
  metadata: { name: KMS_CRYPTO_KEY },
  keyRingRef: { name: KMS_KEY_RING },
  purpose: "ENCRYPT_DECRYPT",
  rotationPeriod: "7776000s",
  versionTemplate: { algorithm: "GOOGLE_SYMMETRIC_ENCRYPTION" },
});

// ── Backups ────────────────────────────────────────────────────────

export const { bucket: backupBucket } = GcsBucket({
  name: BACKUP_BUCKET,
  location: "US",
  versioning: true,
  kmsKeyName: `projects/${GCP_PROJECT_ID}/locations/us/keyRings/${KMS_KEY_RING}/cryptoKeys/${KMS_CRYPTO_KEY}`,
  lifecycleNearlineAfterDays: 30,
  lifecycleDeleteAfterDays: 90,
});

// CMEK on a bucket needs the GCS service agent to be able to use the key. That
// agent is addressed by project NUMBER, not project id — hence the second
// build parameter.
export const gcsKmsBinding = new IAMPolicyMember({
  metadata: { name: "gcs-kms-encrypter-decrypter" },
  member: `serviceAccount:service-${GCP_PROJECT_NUMBER}@gs-project-accounts.iam.gserviceaccount.com`,
  role: "roles/cloudkms.cryptoKeyEncrypterDecrypter",
  resourceRef: {
    apiVersion: "kms.cnrm.cloud.google.com/v1beta1",
    kind: "KMSCryptoKey",
    name: KMS_CRYPTO_KEY,
  },
});

// ── WAF ────────────────────────────────────────────────────────────
// Attached to each region's UI backend through a BackendConfig, which
// CockroachDbRegionStack emits when it is given a policy name.

export const wafPolicy = new SecurityPolicy({
  metadata: { name: WAF_POLICY },
  adaptiveProtectionConfig: {
    layer7DdosDefenseConfig: { enable: true },
  },
  rule: [
    {
      action: "rate_based_ban",
      priority: 1000,
      match: { versionedExpr: "SRC_IPS_V1", config: { srcIpRanges: ["*"] } },
      rateLimitOptions: {
        conformAction: "allow",
        exceedAction: "deny(429)",
        rateLimitThreshold: { count: 3000, intervalSec: 60 },
        banDurationSec: 60,
      },
      description: "Rate limit: 3000 req/min per IP, 1-min ban",
    },
    {
      action: "deny(403)",
      priority: 2000,
      match: { expr: { expression: "evaluatePreconfiguredWaf('xss-v33-stable')" } },
      description: "Block XSS attacks",
    },
    {
      action: "deny(403)",
      priority: 2001,
      match: { expr: { expression: "evaluatePreconfiguredWaf('sqli-v33-stable')" } },
      description: "Block SQL injection attacks",
    },
    {
      action: "allow",
      priority: 2147483647,
      match: { versionedExpr: "SRC_IPS_V1", config: { srcIpRanges: ["*"] } },
      description: "Default allow",
    },
  ],
});
