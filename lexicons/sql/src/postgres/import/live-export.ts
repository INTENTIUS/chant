/**
 * Live export: `chant import --from <env>` writes a Postgres server's schema as
 * declarations, each object as the statements the catalog's own printers
 * give for it (`../live/catalog.ts`), the canonical form.
 *
 * - `selector.type` is an entity type (`Postgres::Table`); `selector.name` is
 *   `name` or `schema.name`.
 * - `owned` keeps the objects whose comment carries chant's ownership marker.
 * - Another tool's objects (an ORM's revision table, and its sequence and
 *   indexes) are left out with a warning naming the tool: they are its, and
 *   a declaration of them would have chant fight it.
 * - `verbatim` changes nothing yet: the printers already leave out what the
 *   server would add by itself.
 * - Where the profile manages access (`sql.profiles.<env>.access`), the
 *   policies and each table's row-level security come with the objects, and
 *   the privileges on them and the default privileges are written as `grant`
 *   declarations: the GRANT and REVOKE statements that take a new object's
 *   privileges to what the server holds. Roles are the environment's and are
 *   not imported.
 */

import type { ExportedTemplate, ResourceSelector } from "@intentius/chant/lexicon";
import { bindPostgres, type BindOptions } from "../live/bind";
import { markProviderOwned, readLiveSchema } from "../live/catalog";
import { objectsToIR, type ImportedPgObject } from "./ir";
import { isChantManaged } from "../../core/ownership";
import { importedAccess } from "../access/import";

export interface ExportOptions extends Omit<BindOptions, "environment"> {
  environment: string;
  stack?: string;
  region?: string;
  selector?: ResourceSelector;
  owned?: boolean;
  verbatim?: boolean;
}

export async function exportResources(options: ExportOptions): Promise<ExportedTemplate> {
  const { target, client } = await bindPostgres(options);
  let live;
  let access: ImportedPgObject[] = [];
  try {
    live = markProviderOwned(await readLiveSchema(client, { schemas: target.schemas, access: target.access === true }), target.provider);
    // Where the profile manages access, the privileges on what is imported, and the default privileges, as grant declarations.
    if (target.access === true && !options.selector) access = await importedAccess(client, live.filter((o) => !o.foreign && !o.unsupported && (!options.owned || isChantManaged(o.comment))), target.schemas);
  } finally {
    await client.end();
  }
  const warnings: string[] = [];
  const objects: ImportedPgObject[] = [];
  for (const o of live) {
    if (options.owned && !isChantManaged(o.comment)) continue;
    if (options.selector?.type && o.type !== options.selector.type) continue;
    const name = options.selector?.name;
    if (name !== undefined && name !== o.name && name !== `${o.schema}.${o.name}`) continue;
    if (o.unsupported) {
      warnings.push(`${o.schema ? `${o.schema}.` : ""}${o.name}${o.signature ?? ""} is left out: ${o.unsupported}`);
      continue;
    }
    if (o.foreign) {
      warnings.push(`${o.schema ? `${o.schema}.` : ""}${o.name} is kept by ${o.foreign}; left out, since declaring it would have chant change what that tool owns`);
      continue;
    }
    objects.push({ type: o.type, ...(o.schema ? { schema: o.schema } : {}), name: o.name, ddl: o.statement });
  }
  return objectsToIR([...objects, ...access], warnings) as ExportedTemplate;
}
