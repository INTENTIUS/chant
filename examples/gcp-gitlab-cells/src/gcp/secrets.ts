import { SecretManagerSecret, SecretManagerSecretVersion } from "@intentius/chant-lexicon-gcp";
import { cells, shared } from "../config";

function cellSecrets(cellName: string) {
  const secrets = ["db-password", "redis-password", "redis-cache-password", "root-password", "rails-secret"];
  return secrets.map(key => {
    const secret = new SecretManagerSecret({
      metadata: { name: `gitlab-${cellName}-${key}` },
      replication: { automatic: {} },
    });
    const version = new SecretManagerSecretVersion({
      metadata: { name: `gitlab-${cellName}-${key}-v1` },
      secretRef: { name: `gitlab-${cellName}-${key}` },
      secretData: { value: "PLACEHOLDER" },
    });
    return { secret, version };
  });
}

export const cellSecretSets = cells.map(c => cellSecrets(c.name));

// Shared SMTP secret
export const smtpSecret = new SecretManagerSecret({
  metadata: { name: "gitlab-smtp-password" },
  replication: { automatic: {} },
});
