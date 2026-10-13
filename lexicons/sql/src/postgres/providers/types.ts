/**
 * What the Postgres dialect knows about a managed provider (#3282): the
 * roles and schemas the provider owns, the extensions it lets a customer
 * create, and the statements it refuses because they need a superuser.
 *
 * The lists are data, one file per provider, each citing the page it was read
 * from and the date it was read. A provider changes its lists without
 * announcing it, so a list is a snapshot, not a contract: an extension a
 * provider added since is reported by SQLPG004 as not allowed until the list
 * is refreshed, and `toCheck` names what a file did not verify.
 */

/** The providers the dialect has data for. */
export const POSTGRES_PROVIDERS = ["rds", "aurora", "cloud-sql", "azure", "neon", "supabase"] as const;

export type PostgresProvider = (typeof POSTGRES_PROVIDERS)[number];

/** A documentation page a provider's data was read from. */
export interface ProviderSource {
  url: string;
  /** ISO date the page was read. */
  readOn: string;
  /** What the page was used for. */
  covers: string;
}

/** A statement the provider refuses, matched on the statement's text with comments and string contents removed. */
export interface RefusedStatement {
  id: string;
  /** Tested against the upper-cased statement with whitespace collapsed. */
  pattern: RegExp;
  reason: string;
}

export interface ProviderData {
  provider: PostgresProvider;
  /** The provider's name as its documentation spells it. */
  label: string;
  sources: readonly ProviderSource[];
  /** Roles the provider creates and owns; a declared role of this name is refused or foreign. */
  reservedRoles: readonly string[];
  /** Schemas the provider creates and owns. */
  reservedSchemas: readonly string[];
  /** Extensions the provider lets a customer create (`CREATE EXTENSION name`). */
  allowedExtensions: readonly string[];
  /**
   * Whether `allowedExtensions` is the provider's whole list. When false the
   * list is what a page named and SQLPG004 stays silent about a name outside
   * it, because the page that has the full list could not be read.
   */
  extensionListComplete: boolean;
  /** Extensions the provider installs and owns; objects they create are the provider's. */
  providerExtensions: readonly string[];
  refusedStatements: readonly RefusedStatement[];
  /** What the data file did not verify against a page, each with the URL to check. */
  toCheck: readonly string[];
}

/** The `sql.provider` setting, as a profile or the namespace holds it. */
export type ProviderSetting = PostgresProvider;

/** Split a whitespace-separated list, so a long extension list stays readable in source. */
export const words = (s: string): string[] => s.split(/\s+/).filter(Boolean);

/** Statements that need the superuser every managed provider withholds. */
export const COMMON_REFUSED: readonly RefusedStatement[] = [
  { id: "alter-system", pattern: /^ALTER SYSTEM\b/, reason: "ALTER SYSTEM writes postgresql.auto.conf, which a managed service owns; use the provider's parameter settings" },
  { id: "copy-program", pattern: /^COPY\b.*\b(FROM|TO) PROGRAM\b/, reason: "COPY ... PROGRAM runs a command on the host, which the provider does not give out" },
  { id: "superuser-role", pattern: /^(CREATE|ALTER) (ROLE|USER)\b.*\bSUPERUSER\b/, reason: "the SUPERUSER attribute cannot be granted on a managed service" },
];
