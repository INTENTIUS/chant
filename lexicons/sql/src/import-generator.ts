/**
 * The import generator for every dialect: an IR whose resources are Postgres
 * types goes to the Postgres generator, any other to ClickHouse's. A build
 * holds one dialect, and so does an import.
 */

import type { GeneratedFile, TypeScriptGenerator } from "@intentius/chant/import/generator";
import type { TemplateIR } from "@intentius/chant/import/parser";
import { ClickHouseGenerator } from "./clickhouse/import/generator";
import { PostgresGenerator } from "./postgres/import/generator";

export const sqlTemplateGenerator: TypeScriptGenerator = {
  ownsLayout: true,
  generate(ir: TemplateIR): GeneratedFile[] {
    const postgres = ir.resources.some((r) => r.type.startsWith("Postgres::"));
    return (postgres ? new PostgresGenerator() : new ClickHouseGenerator()).generate(ir);
  },
};
