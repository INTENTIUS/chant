/**
 * VaultSecuredProject composite — Project + Vault resolver + environments
 * with `${vault.*}` references + config.
 *
 * A higher-level construct for Flyway projects that retrieve database
 * credentials from HashiCorp Vault using Flyway's built-in Vault resolver.
 */

export interface VaultEnvironmentEntry {
  /** Environment name (e.g., "staging", "prod"). */
  name: string;
  /** JDBC URL for this environment (may contain `${vault.*}` placeholders). */
  url: string;
  /** Vault secret key for the database user (default: `"<name>_user"`). */
  userKey?: string;
  /** Vault secret key for the database password (default: `"<name>_password"`). */
  passwordKey?: string;
  /** Schemas managed in this environment. */
  schemas?: string[];
}

export interface VaultSecuredProjectProps {
  /** Project name — used as the Flyway project identifier. */
  name: string;
  /** Database type (e.g., "postgresql", "mysql"). */
  databaseType: string;
  /** Vault server URL (e.g., "https://vault.example.com"). */
  vaultUrl: string;
  /** Vault secret path (e.g., "secret/data/flyway"). */
  vaultSecretPath?: string;
  /** Vault token — typically a `${env.*}` reference (default: `"${env.VAULT_TOKEN}"`). */
  vaultToken?: string;
  /** List of environments to create. */
  environments: VaultEnvironmentEntry[];
  /** Default schemas applied to environments that don't specify their own. */
  schemas?: string[];
  /** Migration locations (default: ["filesystem:sql"]). */
  locations?: string[];
}

export interface VaultSecuredProjectResult {
  /** Props for a FlywayProject resource. */
  project: Record<string, unknown>;
  /** Props for a VaultResolver property. */
  vaultResolver: Record<string, unknown>;
  /** Props for each Environment resource, keyed by environment name. */
  environments: Record<string, Record<string, unknown>>;
  /** Props for a FlywayConfig resource. */
  config: Record<string, unknown>;
}

/**
 * Create a VaultSecuredProject composite — returns props for a FlywayProject,
 * a VaultResolver, N Environment resources with `${vault.*}` credential
 * references, and a FlywayConfig.
 *
 * @example
 * ```ts
 * import { VaultSecuredProject } from "@intentius/chant-lexicon-flyway";
 *
 * const { project, vaultResolver, environments, config } = VaultSecuredProject({
 *   name: "payments-db",
 *   databaseType: "postgresql",
 *   vaultUrl: "https://vault.example.com",
 *   vaultSecretPath: "secret/data/payments",
 *   environments: [
 *     { name: "staging", url: "jdbc:postgresql://staging:5432/payments" },
 *     { name: "prod", url: "jdbc:postgresql://prod:5432/payments" },
 *   ],
 * });
 *
 * export { project, vaultResolver, environments, config };
 * ```
 */
export function VaultSecuredProject(
  props: VaultSecuredProjectProps,
): VaultSecuredProjectResult {
  const {
    name,
    databaseType,
    vaultUrl,
    vaultSecretPath = "secret/data/flyway",
    vaultToken = "${env.VAULT_TOKEN}",
    environments: envEntries,
    schemas = ["public"],
    locations = ["filesystem:sql"],
  } = props;

  const project: Record<string, unknown> = {
    name,
  };

  const vaultResolver: Record<string, unknown> = {
    url: vaultUrl,
    token: vaultToken,
    secretPath: vaultSecretPath,
  };

  const environments: Record<string, Record<string, unknown>> = {};
  for (const entry of envEntries) {
    const userKey = entry.userKey ?? `${entry.name}_user`;
    const passwordKey = entry.passwordKey ?? `${entry.name}_password`;

    environments[entry.name] = {
      displayName: entry.name,
      url: entry.url,
      user: `\${vault.${userKey}}`,
      password: `\${vault.${passwordKey}}`,
      schemas: entry.schemas ?? schemas,
    };
  }

  const config: Record<string, unknown> = {
    defaultSchema: schemas[0],
    locations,
    databaseType,
    validateMigrationNaming: true,
  };

  return { project, vaultResolver, environments, config };
}
