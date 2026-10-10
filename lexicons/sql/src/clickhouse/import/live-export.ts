/**
 * Live export: `chant import --from <env>` writes the server's schema as
 * `database`, `table` and `view` declarations.
 *
 * Every object in the environment's databases is read with `SHOW CREATE`, the
 * server's canonical form, which is the baseline #3046 question 5 asks for.
 * By default what the server adds on its own is left out (settings at their
 * default, a view's inferred column list), so the declaration says what an
 * author would; `verbatim` keeps the statement as the server printed it.
 *
 * - `selector.type` is an entity type (`ClickHouse::Table`); `selector.name` is
 *   an object name, `db.name` or `name`.
 * - `owned` keeps the objects whose comment carries chant's ownership marker
 *   (`../ownership.ts`), the trailer the applier stamps. The trailer itself is
 *   never written into a declaration: `readLiveSchema` takes it off.
 * - a migration runner's history table (`schema_migrations`,
 *   `goose_db_version`) is left out with a warning (#3676), as on Postgres.
 */

import type { ExportedTemplate, ResourceSelector } from "@intentius/chant/lexicon";
import { bindClickHouse, type BindOptions } from "../live/bind";
import { readLiveSchema } from "../live/catalog";
import { objectsToIR, stripServerDefaults, type ImportedObject } from "./ir";
import { isChantManaged } from "../ownership";

export interface ExportOptions extends Omit<BindOptions, "environment"> {
  environment: string;
  stack?: string;
  region?: string;
  selector?: ResourceSelector;
  owned?: boolean;
  verbatim?: boolean;
}

export async function exportResources(options: ExportOptions): Promise<ExportedTemplate> {
  const target = await bindClickHouse(options);
  const live = await readLiveSchema(target);
  const selected = live.filter((o) => {
    if (options.owned && !isChantManaged(o.comment)) return false;
    if (options.selector?.type && o.type !== options.selector.type) return false;
    const name = options.selector?.name;
    if (name !== undefined && name !== o.name && name !== `${o.database}.${o.name}`) return false;
    return true;
  });
  const warnings: string[] = [];
  const objects: ImportedObject[] = selected
    // The `default` database exists on every server; declaring it would make apply create what is there.
    .filter((o) => !(o.type === "ClickHouse::Database" && o.name === "default"))
    .filter((o) => {
      if (!o.foreign) return true;
      warnings.push(`${o.database ? `${o.database}.` : ""}${o.name} is kept by ${o.foreign}; left out, since declaring it would have chant change what that tool owns`);
      return false;
    })
    .map((o) => ({
      type: o.type,
      ...(o.database ? { database: o.database } : {}),
      name: o.name,
      ddl: options.verbatim ? o.statement : stripServerDefaults(o.statement),
    }));
  return objectsToIR(objects, warnings) as ExportedTemplate;
}
