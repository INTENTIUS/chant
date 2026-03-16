// Secret Manager secrets for CockroachDB TLS certificates.
// Cert values are pushed by scripts/generate-certs.sh after generation.

import { SecretManagerSecret } from "@intentius/chant-lexicon-gcp";

const CERT_SECRETS = [
  "crdb-ca-crt",
  "crdb-node-crt",
  "crdb-node-key",
  "crdb-client-root-crt",
  "crdb-client-root-key",
] as const;

export const certSecrets = CERT_SECRETS.map(name => new SecretManagerSecret({
  metadata: { name },
  replication: { automatic: true },
}));
