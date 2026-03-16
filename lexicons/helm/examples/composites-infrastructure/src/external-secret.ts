import { HelmExternalSecret } from "@intentius/chant-lexicon-helm";

export const { chart, values, externalSecret } = HelmExternalSecret({
  name: "app-secrets",
  secretStoreName: "vault-backend",
  secretStoreKind: "ClusterSecretStore",
  data: {
    DATABASE_URL: "secret/data/myapp/db-url",
    API_KEY: "secret/data/myapp/api-key",
    REDIS_PASSWORD: "secret/data/myapp/redis-password",
  },
  refreshInterval: "30m",
});
