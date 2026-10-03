/**
 * The `sql` namespace in `chant.config.ts`.
 *
 * ```ts
 * import type { ChantConfig } from "@intentius/chant/config";
 * import "@intentius/chant-lexicon-sql";   // brings the `sql` key into ChantConfig
 *
 * export default {
 *   lexicons: ["sql"],
 *   sql: {
 *     dialect: "clickhouse",
 *     profiles: {
 *       staging: { url: "http://clickhouse.staging:8123", user: { env: "CH_USER" }, password: { env: "CH_PASSWORD" } },
 *       prod: { url: "https://clickhouse.example.com:8443", user: { env: "CH_USER" }, password: { env: "CH_PROD_PASSWORD" }, databases: ["analytics"] },
 *     },
 *   },
 * } satisfies ChantConfig;
 * ```
 *
 * A profile is keyed by chant environment, as `grafana.profiles.<env>` is:
 * the server `chant import --from <env>`, `chant lifecycle diff <env> --live`
 * and `plan` read. Credentials are named by their environment variable, never
 * written in the config. An environment with no profile falls back to
 * `CLICKHOUSE_URL`, `CLICKHOUSE_USER` and `CLICKHOUSE_PASSWORD`, or for
 * Postgres `POSTGRES_URL`, `POSTGRES_USER` and `POSTGRES_PASSWORD`. A profile
 * whose `url` is `postgres://` or `postgresql://` is a Postgres server.
 *
 * `dialect` names the database a project's schema is for. Declarations carry
 * their dialect in their own type (a ClickHouse table is `ClickHouse::Table`),
 * so the setting is for the things a declaration cannot answer: which dialect
 * a live environment is read as on import, and which dialect's checks run on
 * output that names none. It defaults to `clickhouse`, the first dialect.
 * `postgres` is the second (#3289). A list (`dialect: ["clickhouse",
 * "postgres"]`) is accepted for a workspace with members of more than one
 * dialect (#3047 question 1); one build still holds one dialect.
 *
 * `provider` (#3282) names the managed Postgres service, on the namespace or
 * on one profile: `sql: { dialect: "postgres", provider: "rds" }`, or
 * `profiles: { prod: { url, provider: "aurora" } }`. A provider's data lives
 * in `@intentius/chant-lexicon-sql/postgres` (`providerData`).
 */

import { z } from "zod";
import type { ChantConfig } from "@intentius/chant/config";
import { PLANNED_SQL_DIALECTS, SQL_DIALECTS } from "./dialects";
import { POSTGRES_PROVIDERS } from "./postgres/providers/types";
import { POSTGRES_MAJORS } from "./spec/postgres-pin";

const envRef = z.strictObject({ env: z.string() });

/** The managed Postgres service an environment runs on (#3282). */
const providerName = z.enum(POSTGRES_PROVIDERS, {
  error: () => `expected a Postgres provider (${POSTGRES_PROVIDERS.join(", ")})`,
});

export const sqlProfileSchema = z.strictObject({
  /**
   * Where the server is. ClickHouse: the base URL of its HTTP interface
   * (`http://clickhouse:8123`). Postgres: a connection URL
   * (`postgres://db.internal:5432/shop`), with no password in it; the scheme
   * is what makes a profile a Postgres one.
   */
  url: z.string(),
  /** The user, named by its environment variable. `default` when omitted. */
  user: envRef.optional(),
  /** The password, named by its environment variable. */
  password: envRef.optional(),
  /**
   * The databases this environment's schema lives in. Import reads these and
   * nothing else; when omitted, every database except the server's own
   * (`system`, `information_schema`, `INFORMATION_SCHEMA`).
   */
  databases: z.array(z.string()).optional(),
  /** The database an unqualified declaration is created in. `default` when omitted. */
  defaultDatabase: z.string().optional(),
  /**
   * Postgres: the schemas this environment's schema lives in. Import and
   * observation read these and nothing else; when omitted, every schema except
   * the server's own (`pg_catalog`, `information_schema`, `pg_toast`, the temp
   * schemas).
   */
  schemas: z.array(z.string()).optional(),
  /** Postgres: the schema an unqualified declaration is created in. `public` when omitted. */
  defaultSchema: z.string().optional(),
  /**
   * The managed service this environment's Postgres runs on, when it differs
   * from `sql.provider`. Import reads the provider's own roles, schemas and
   * extensions as foreign.
   */
  provider: providerName.optional(),
});

const dialectName = z.enum(SQL_DIALECTS);

/** Why a `dialect` value is refused: a planned dialect is "not implemented yet", anything else unknown. */
function dialectError(input: unknown): string {
  const names = Array.isArray(input) ? input : [input];
  const planned = names.find((n): n is string => typeof n === "string" && (PLANNED_SQL_DIALECTS as readonly string[]).includes(n));
  if (planned !== undefined) {
    return `the ${planned} dialect is not implemented yet; the implemented dialects are ${SQL_DIALECTS.join(", ")}`;
  }
  return `expected a dialect (${SQL_DIALECTS.join(", ")}) or a non-empty list of them`;
}

export const sqlConfigSchema = z.strictObject({
  /** The dialect, or the dialects, the project's schema is for. */
  dialect: z.union([dialectName, z.array(dialectName).min(1)], { error: (iss) => dialectError(iss.input) }).optional(),
  /**
   * The managed Postgres service the project deploys to (`rds`, `aurora`,
   * `cloud-sql`, `azure`, `neon`, `supabase`). SQLPG004 reads it to refuse an
   * extension the provider does not allow. Omit it for a self-hosted server.
   */
  provider: providerName.optional(),
  /**
   * The Postgres major the project targets. The editor completes and hovers
   * only what that major has (a function added in 18 is not offered at 16);
   * without it, the newest supported major is used.
   */
  postgresMajor: z
    .number()
    .int()
    .refine((n) => POSTGRES_MAJORS.includes(n), { error: `expected a supported Postgres major (${POSTGRES_MAJORS.join(", ")})` })
    .optional(),
  /** One server per chant environment. */
  profiles: z.record(z.string(), sqlProfileSchema).optional(),
});

export type SqlProfile = z.infer<typeof sqlProfileSchema>;

export type SqlConfig = z.infer<typeof sqlConfigSchema>;

declare module "@intentius/chant/config" {
  interface ChantConfig {
    sql?: SqlConfig;
  }
}

/** Compile-time proof that the augmentation above reaches `ChantConfig`. */
export type SqlConfigNamespace = NonNullable<ChantConfig["sql"]>;
