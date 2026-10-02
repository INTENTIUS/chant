/**
 * The sql lexicon's generation pipeline.
 *
 * One dialect today, ClickHouse. Its "schema" is the catalog a pinned
 * `clickhouse-server` reports from `system.*`, committed as
 * `src/spec/clickhouse-catalog.snapshot.json` (chant #3195). `fetchSchemas`
 * reads that snapshot, and starts the pinned server only on a pin move; see
 * `src/spec/fetch.ts`.
 *
 * Outputs, under `src/generated/`:
 *
 * - `clickhouse-types.ts` (and `index.d.ts`, the packaged copy): unions of every
 *   engine, type family, codec, skip index type, format and function name, and
 *   the `MergeTreeSettings` / `QuerySettings` interfaces.
 * - `clickhouse.ts`: the tables lint and the LSP read, with the hand-written
 *   overlays (engine argument kinds, codec parameters) merged in.
 * - `lexicon-sql.json`: the entity registry.
 */

import {
  generatePipeline,
  writeGeneratedArtifacts,
  type GenerateOptions,
  type GenerateResult,
  type ParsedResult,
} from "@intentius/chant/codegen/generate";
import { NamingStrategy } from "@intentius/chant/codegen/naming";
import { dirname } from "path";
import { fileURLToPath } from "url";
import { CATALOG_KEY, fetchSchemas } from "../spec/fetch";
import { parseCatalog, type ClickHouseCatalog } from "../spec/catalog";
import { renderClickHouseModule } from "./clickhouse-module";
import { buildRegistry } from "./registry";

export type { GenerateResult };

export interface ClickHouseParsed extends ParsedResult {
  typeName: string;
  catalog: ClickHouseCatalog;
}

export async function generate(opts: GenerateOptions = {}): Promise<GenerateResult> {
  let notes: string[] = [];
  let tables = "";

  const result = await generatePipeline<ClickHouseParsed>(
    {
      fetchSchemas: (fetchOpts) => fetchSchemas({ force: fetchOpts.force }),

      parseSchema: (typeName, data) => {
        if (typeName !== CATALOG_KEY) return null;
        const catalog = parseCatalog(data.toString("utf-8"));
        return {
          typeName,
          catalog,
          propertyTypes: [{ name: "MergeTreeSettings" }, { name: "QuerySettings" }],
          enums: [],
        };
      },

      createNaming: (results) =>
        new NamingStrategy(
          results.map((r) => ({ typeName: r.typeName, propertyTypes: r.propertyTypes })),
          {
            priorityNames: {},
            priorityAliases: {},
            priorityPropertyAliases: {},
            serviceAbbreviations: {},
            shortName: (t) => t.split("::").pop()!,
            serviceName: (t) => t.split("::")[0] ?? t,
          },
        ),

      generateRegistry: () => buildRegistry(),

      generateTypes: (results) => {
        const catalog = results.find((r) => r.typeName === CATALOG_KEY)?.catalog;
        if (!catalog) throw new Error("no ClickHouse catalog was parsed");
        const rendered = renderClickHouseModule(catalog);
        notes = rendered.notes;
        tables = rendered.tables;
        return rendered.declarations;
      },

      generateRuntimeIndex: () => tables,
    },
    opts,
  );

  if (result.warnings.length > 0) {
    throw new Error(`sql generation failed:\n  ${result.warnings.map((w) => `${w.file}: ${w.error}`).join("\n  ")}`);
  }
  if (opts.verbose) for (const note of notes) console.error(`[sql] ${note}`);
  return result;
}

/** Write the generated files under `src/generated/`. */
export function writeGeneratedFiles(result: GenerateResult, pkgDir?: string): void {
  const baseDir = pkgDir ?? dirname(dirname(dirname(fileURLToPath(import.meta.url))));
  writeGeneratedArtifacts({
    baseDir,
    files: {
      "lexicon-sql.json": result.lexiconJSON,
      "index.d.ts": result.typesDTS,
      "clickhouse-types.ts": result.typesDTS,
      "clickhouse.ts": result.indexTS,
    },
  });
}
