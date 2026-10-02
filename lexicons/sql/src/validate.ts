/**
 * Validate the sql lexicon's generated artifacts.
 *
 * The core checks (the registry parses, `index.d.ts` exists and compiles), plus
 * the ClickHouse catalog's own: the generated tables exist, the committed
 * snapshot is at the pin, and the names a schema leans on hardest are still
 * in it. A pin move that drops one of those would otherwise surface as lint
 * going quiet, not as a failure.
 */

import { existsSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { validateLexiconArtifacts, type ValidateCheck, type ValidateResult } from "@intentius/chant/codegen/validate";
import { CLICKHOUSE_VERSION } from "./spec/pin";
import { parseCatalog } from "./spec/catalog";

export type { ValidateCheck, ValidateResult } from "@intentius/chant/codegen/validate";

/** The entity kinds the registry must carry. */
const REQUIRED_ENTITIES = ["Database", "Table", "View", "MaterializedView"];

/** Engines a ClickHouse schema declares most: the MergeTree family and the engines beside it. */
const REQUIRED_ENGINES = [
  "MergeTree",
  "ReplacingMergeTree",
  "SummingMergeTree",
  "AggregatingMergeTree",
  "CollapsingMergeTree",
  "VersionedCollapsingMergeTree",
  "ReplicatedMergeTree",
  "ReplicatedReplacingMergeTree",
  "Distributed",
  "Buffer",
  "Memory",
  "Null",
  "MaterializedView",
  "View",
];

/** Column type families the parser and the sort-key rules reason about. */
const REQUIRED_TYPE_FAMILIES = [
  "String",
  "UInt64",
  "Int64",
  "Float64",
  "DateTime",
  "DateTime64",
  "Date",
  "UUID",
  "Decimal",
  "Nullable",
  "LowCardinality",
  "Array",
  "Map",
  "Tuple",
  "Enum8",
  "AggregateFunction",
  "SimpleAggregateFunction",
];

/** Codecs the codec overlay types parameters for. */
const REQUIRED_CODECS = ["ZSTD", "LZ4", "LZ4HC", "Delta", "DoubleDelta", "Gorilla", "T64"];

export async function validate(opts?: { basePath?: string }): Promise<ValidateResult> {
  const basePath = opts?.basePath ?? dirname(dirname(fileURLToPath(import.meta.url)));

  const core = await validateLexiconArtifacts({
    lexiconJsonFilename: "lexicon-sql.json",
    requiredNames: REQUIRED_ENTITIES,
    basePath,
  });
  const checks: ValidateCheck[] = [...core.checks];

  const tables = join(basePath, "src", "generated", "clickhouse.ts");
  checks.push(
    existsSync(tables)
      ? { name: "clickhouse-tables-exist", ok: true }
      : { name: "clickhouse-tables-exist", ok: false, error: "src/generated/clickhouse.ts not found; run npm run generate" },
  );

  try {
    const catalog = parseCatalog(readFileSync(join(basePath, "src", "spec", "clickhouse-catalog.snapshot.json"), "utf-8"));
    checks.push(
      catalog.version === CLICKHOUSE_VERSION
        ? { name: "clickhouse-snapshot-at-pin", ok: true }
        : {
            name: "clickhouse-snapshot-at-pin",
            ok: false,
            error: `the snapshot is ${catalog.version}, the pin is ${CLICKHOUSE_VERSION}; run npm run generate to refresh it`,
          },
    );
    const missing = (names: readonly string[], have: Iterable<string>) => {
      const set = new Set(have);
      return names.filter((n) => !set.has(n));
    };
    const gaps = [
      ...missing(REQUIRED_ENGINES, catalog.tableEngines.map((e) => e.name)).map((n) => `engine ${n}`),
      ...missing(REQUIRED_TYPE_FAMILIES, catalog.typeFamilies.map((t) => t.name)).map((n) => `type ${n}`),
      ...missing(REQUIRED_CODECS, catalog.codecs.map((c) => c.name)).map((n) => `codec ${n}`),
    ];
    checks.push(
      gaps.length === 0
        ? { name: "clickhouse-required-names", ok: true }
        : { name: "clickhouse-required-names", ok: false, error: `missing at the pin: ${gaps.join(", ")}` },
    );
  } catch (err) {
    checks.push({
      name: "clickhouse-snapshot-readable",
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return { success: checks.every((c) => c.ok), checks };
}
