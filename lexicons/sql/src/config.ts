/**
 * The `sql` namespace in `chant.config.ts`.
 *
 * ```ts
 * import type { ChantConfig } from "@intentius/chant/config";
 * import "@intentius/chant-lexicon-sql";   // brings the `sql` key into ChantConfig
 *
 * export default {
 *   lexicons: ["sql"],
 *   sql: { dialect: "clickhouse" },
 * } satisfies ChantConfig;
 * ```
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

export const sqlConfigSchema = z.strictObject({
  dialect: z.enum(SQL_DIALECTS).optional(),
});

export type SqlConfig = z.infer<typeof sqlConfigSchema>;

declare module "@intentius/chant/config" {
  interface ChantConfig {
    sql?: SqlConfig;
  }
}

/** Compile-time proof that the augmentation above reaches `ChantConfig`. */
export type SqlConfigNamespace = NonNullable<ChantConfig["sql"]>;
