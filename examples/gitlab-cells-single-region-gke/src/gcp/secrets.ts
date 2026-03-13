import { SecretManagerSecret, SecretManagerSecretVersion } from "@intentius/chant-lexicon-gcp";
import { cells, shared } from "../config";

const SECRET_KEYS = ["db-password", "redis-password", "redis-cache-password", "root-password", "rails-secret"];

// Per-cell Secret Manager secrets — flat arrays so chant discovery can find them.
export const cellSecrets = cells.flatMap(c =>
  SECRET_KEYS.map(key => new SecretManagerSecret({
    metadata: { name: `gitlab-${c.name}-${key}` },
    replication: { automatic: true },
  }))
);

export const cellSecretVersions = cells.flatMap(c =>
  SECRET_KEYS.map(key => new SecretManagerSecretVersion({
    metadata: { name: `gitlab-${c.name}-${key}-v1` },
    secretRef: { name: `gitlab-${c.name}-${key}` },
    secretData: { value: "PLACEHOLDER" },
  }))
);

// Shared SMTP secret
export const smtpSecret = new SecretManagerSecret({
  metadata: { name: "gitlab-smtp-password" },
  replication: { automatic: true },
});
