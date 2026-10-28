/**
 * The shape of choudoufu's `live/module-compat.json` (choudoufu#2292,
 * `tools/modcompat/modcompat.go`), as far as the known-module catalog reads
 * it. Only the static tier is typed here; see `./refresh-cli.ts`.
 */

/** One refusal on a static row: a choudoufu refusal ID and where it is documented. */
export interface StaticRefusal {
  id: string;
  layer: string;
  sites: number;
  docs_ref: string;
  docs_url: string;
}

/** One terraform-aws-modules example measured offline in the onboarded form. */
export interface StaticRow {
  tier: "static";
  /** Registry address, `terraform-aws-modules/vpc/aws`. */
  module: string;
  /** The module repository's tag, `v6.6.1`. */
  version: string;
  /** The example directory inside the module repository. */
  example: string;
  date: string;
  commit: string;
  aws_provider: string;
  verdict: "clear" | "refused" | "unmeasured";
  /** Eligible data-source reads. These never refuse and are not refusals. */
  reads: number;
  refusals: StaticRefusal[];
  reason?: string;
  partial_schemas?: string[];
}

export interface StaticSource {
  module: string;
  repo: string;
  version: string;
  commit: string;
  glob: string;
  examples: number;
}

/** How the static tier was measured. */
export interface StaticMeasurement {
  date: string;
  commit: string;
  instrument: string;
  form: string;
  schemas: boolean;
  second_pass: boolean;
  aws_provider: string;
  sources: StaticSource[];
}

/** The parts of the file the catalog reads. */
export interface ModuleCompatFile {
  schema: number;
  static_measurement: StaticMeasurement;
  static: StaticRow[];
}

const VERDICTS = new Set(["clear", "refused", "unmeasured"]);

/**
 * Check a parsed `live/module-compat.json` against the shape above and return
 * it. Throws on a schema other than 1, a row outside the static tier, or a
 * row whose verdict disagrees with its refusals, so a refresh never vendors a
 * table the catalog would misread.
 */
export function parseModuleCompat(raw: unknown): ModuleCompatFile {
  const file = raw as Partial<ModuleCompatFile>;
  if (file?.schema !== 1) throw new Error(`module-compat.json: schema ${String(file?.schema)}, expected 1`);
  if (!file.static_measurement || !Array.isArray(file.static)) {
    throw new Error("module-compat.json: missing static_measurement or static");
  }
  for (const row of file.static) {
    const where = `${row.module} ${row.version} ${row.example}`;
    if (row.tier !== "static") throw new Error(`module-compat.json: ${where} is in the static array with tier ${row.tier}`);
    if (!VERDICTS.has(row.verdict)) throw new Error(`module-compat.json: ${where} has verdict ${row.verdict}`);
    if (!Array.isArray(row.refusals)) throw new Error(`module-compat.json: ${where} has no refusals list`);
    if ((row.verdict === "refused") !== (row.refusals.length > 0)) {
      throw new Error(`module-compat.json: ${where} is ${row.verdict} with ${row.refusals.length} refusals`);
    }
  }
  return { schema: file.schema, static_measurement: file.static_measurement, static: file.static };
}
