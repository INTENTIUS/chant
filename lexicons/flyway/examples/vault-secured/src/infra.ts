// Vault-secured Flyway project: HashiCorp Vault for database credentials,
// production safety settings, dev environment with local secrets fallback.
// Demonstrates the VaultSecuredProject composite and the resolve intrinsic.

import {
  VaultSecuredProject,
  FlywayProject,
  FlywayConfig,
  Environment,
  VaultResolver,
  LocalSecretResolver,
  resolve,
} from "@intentius/chant-lexicon-flyway";

const result = VaultSecuredProject({
  name: "payments-db",
  databaseType: "postgresql",
  vaultUrl: "https://vault.payments.internal:8200",
  vaultSecretPath: "secret/data/payments/db",
  environments: [
    {
      name: "staging",
      url: "jdbc:postgresql://staging-payments-db.internal:5432/payments",
      userKey: "staging_db_user",
      passwordKey: "staging_db_password",
    },
    {
      name: "prod",
      url: "jdbc:postgresql://prod-payments-db.internal:5432/payments",
      userKey: "prod_db_user",
      passwordKey: "prod_db_password",
    },
  ],
  schemas: ["public", "payments"],
  locations: ["filesystem:sql"],
});

export const project = new FlywayProject(result.project);

export const config = new FlywayConfig({
  ...result.config,
  cleanDisabled: true,
  outOfOrder: false,
});

export const vaultResolver = new VaultResolver(result.vaultResolver);

export const stagingEnv = new Environment(result.environments.staging);

export const prodEnv = new Environment(result.environments.prod);

// Dev environment uses local secrets instead of Vault for offline development
export const localSecrets = new LocalSecretResolver({});

export const devEnv = new Environment({
  name: "dev",
  url: "jdbc:postgresql://localhost:5432/payments_dev",
  user: resolve("localSecret", "db_user"),
  password: resolve("localSecret", "db_password"),
  schemas: ["public", "payments"],
  provisioner: "clean",
});
