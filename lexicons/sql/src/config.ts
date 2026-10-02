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
 * `CLICKHOUSE_URL`, `CLICKHOUSE_USER` and `CLICKHOUSE_PASSWORD`.
 *
 * `dialect` names the database a project's schema is for. Declarations carry
 * their dialect in their own type (a ClickHouse table is `ClickHouse::Table`),
 * so the setting is for the things a declaration cannot answer: which dialect
 * a live environment is read as on import, and which dialect's checks run on
 * output that names none. It defaults to `clickhouse`, the only dialect so far.
 */

import { z } from "zod";
import type { ChantConfig } from "@intentius/chant/config";
import { SQL_DIALECTS } from "./dialects";

const envRef = z.strictObject({ env: z.string() });

export const sqlProfileSchema = z.strictObject({
  /** Base URL of the server's HTTP interface. */
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
});

export const sqlConfigSchema = z.strictObject({
  dialect: z.enum(SQL_DIALECTS).optional(),
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
