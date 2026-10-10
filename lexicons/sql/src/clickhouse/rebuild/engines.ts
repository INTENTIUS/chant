/**
 * Which table engines the rebuild reads as merged (#3674): the verification
 * (`./verify.ts`) and the plan's hand-off note (`../plan/rebuild-handoff.ts`).
 */

/**
 * The MergeTree engines that collapse rows sharing a sorting key when parts
 * merge, as `system.tables.engine` names them, replicated or shared too. A
 * count of such a table depends on which parts have merged; under `FINAL` it
 * does not.
 */
const COLLAPSING_ENGINE = /^(?:Replicated|Shared)?(?:Summing|Replacing|Aggregating|Collapsing|VersionedCollapsing|Coalescing|Graphite)MergeTree$/;

/** Whether an engine collapses rows that share a sorting key (#3674). */
export const collapsesRows = (engine: string | undefined): boolean => COLLAPSING_ENGINE.test(engine ?? "");

/** A column of the new table, as `system.columns` reports it. */
export interface EngineColumn {
  name: string;
  type: string;
  /** Part of the sorting key: the engine never merges its values. */
  inSortingKey: boolean;
  /** Part of the partition key: rows that merge share its value, so a SummingMergeTree does not sum it. */
  inPartitionKey?: boolean;
}

/**
 * How a collapsing engine merges the rows that share a sorting key, as what a
 * merge leaves the same (#3727): for each key, the aggregates it preserves and
 * whether it keeps the key at all. Both tables are grouped by the new table's
 * sorting key and compared on these, so it does not matter which parts have
 * merged, and a table that never collapses (a plain MergeTree) compares with
 * one that does.
 */
export interface CollapseSemantics {
  /** The engine's name without `Replicated` or `Shared`. */
  engine: string;
  /** Per key: what merging leaves unchanged. SQL over the new table's column names. */
  aggregates: string[];
  /** Per key: whether the engine keeps a row for it. Absent: every key keeps one. */
  having?: string;
  /** One line for the summary and the error: what is compared per key. */
  describe: string;
}

/** Split on the commas outside parentheses and quotes. */
export function splitTopLevel(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | undefined;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = undefined;
    } else if (c === "'" || c === '"' || c === "`") quote = c;
    else if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
    else if (c === "," && depth === 0) {
      out.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  const last = text.slice(start).trim();
  if (last || out.length > 0) out.push(last);
  return out;
}

/** The engine's own arguments in `system.tables.engine_full`, without a `Replicated` engine's Keeper path and replica name. */
export function engineArguments(engineFull: string): string[] {
  const m = /^\s*(\w+)\s*\(/.exec(engineFull);
  if (!m) return [];
  let depth = 0;
  let quote: string | undefined;
  const from = m[0].length;
  let end = -1;
  for (let i = from - 1; i < engineFull.length && end < 0; i++) {
    const c = engineFull[i]!;
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = undefined;
    } else if (c === "'") quote = c;
    else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) end = i;
  }
  if (end < 0) return [];
  const args = splitTopLevel(engineFull.slice(from, end)).filter((a) => a !== "");
  if (/^(?:Replicated|Shared)/.test(m[1]!)) while (args.length > 0 && args[0]!.startsWith("'")) args.shift();
  return args;
}

const NUMERIC = /^(?:U?Int(?:8|16|32|64|128|256)|Float(?:32|64)|BFloat16|Decimal(?:32|64|128|256)?\s*\(.*\))$/;
const FLOAT = /^(?:Float(?:32|64)|BFloat16)$/;
/** The SimpleAggregateFunction functions whose result a merge keeps exactly, whatever the order of the rows. */
const SIMPLE_ORDER_FREE = new Set(["sum", "sumWithOverflow", "min", "max", "groupBitAnd", "groupBitOr", "groupBitXor"]);

const quoted = (name: string) => `\`${name.replace(/\\/g, "\\\\").replace(/`/g, "\\`")}\``;
const typeLiteral = (type: string) => `'${type.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
/** A sum in the column's own type, as the engine stores it; a float to 32 bits, since the order rows are added in moves its last bits. */
const summed = (c: EngineColumn) => (FLOAT.test(c.type) ? `toFloat32(sum(${quoted(c.name)}))` : `CAST(sum(${quoted(c.name)}), ${typeLiteral(c.type)})`);

/**
 * What a merge of `engine` keeps per sorting key, or undefined for an engine
 * that does not collapse rows, or whose result depends on the order rows
 * merge in (`GraphiteMergeTree` thins its rows by age).
 */
export function collapseSemantics(engine: string, engineFull: string, columns: readonly EngineColumn[]): CollapseSemantics | undefined {
  if (!collapsesRows(engine)) return undefined;
  const base = engine.replace(/^(?:Replicated|Shared)/, "").replace(/MergeTree$/, "");
  const args = engineArguments(engineFull);
  const values = columns.filter((c) => !c.inSortingKey);
  const named = (n: string | undefined) => (n ? columns.find((c) => c.name === n.replace(/^`|`$/g, "")) : undefined);
  switch (base) {
    case "Summing": {
      // The columns listed, else every numeric column outside the sorting and partition keys; a key whose sums are all zero is removed.
      const listed = args[0] ? splitTopLevel(args[0].replace(/^\((.*)\)$/s, "$1")).map(named) : undefined;
      const sums = (listed ? listed.filter((c): c is EngineColumn => c !== undefined) : values).filter((c) => !c.inSortingKey && !c.inPartitionKey && NUMERIC.test(c.type));
      const aggregates = sums.map(summed);
      return {
        engine: `${base}MergeTree`,
        aggregates,
        ...(aggregates.length > 0 ? { having: `NOT (${aggregates.map((a) => `${a} = 0`).join(" AND ")})` } : {}),
        describe: sums.length > 0 ? `the sums of ${sums.map((c) => c.name).join(", ")}` : "the keys",
      };
    }
    case "Replacing": {
      // The row with the highest version is kept; without a version, the last one written, so only the key is compared.
      const ver = named(args[0]);
      return { engine: `${base}MergeTree`, aggregates: ver ? [`max(${quoted(ver.name)})`] : [], describe: ver ? `the highest ${ver.name}` : "the keys" };
    }
    case "Collapsing":
    case "VersionedCollapsing": {
      // A pair of rows with opposite signs cancels: the sum of the signs is what a merge keeps, and a key whose signs cancel out is removed.
      const sign = named(args[0]);
      if (!sign) return undefined;
      const s = `sum(${quoted(sign.name)})`;
      return { engine: `${base}MergeTree`, aggregates: [s], having: `${s} != 0`, describe: `the sum of ${sign.name}` };
    }
    case "Aggregating": {
      const simple = values.flatMap((c) => {
        const m = /^SimpleAggregateFunction\(\s*(\w+)\s*,/.exec(c.type);
        return m && SIMPLE_ORDER_FREE.has(m[1]!) ? [{ c, fn: m[1]! }] : [];
      });
      return {
        engine: `${base}MergeTree`,
        aggregates: simple.map(({ c, fn }) => `${fn}(${quoted(c.name)})`),
        describe: simple.length > 0 ? `${simple.map(({ c, fn }) => `${fn}(${c.name})`).join(", ")}` : "the keys",
      };
    }
    case "Coalescing": {
      // The last value that is not NULL is kept: whether a column has one is what a merge keeps.
      const nullable = values.filter((c) => /^Nullable\(/.test(c.type));
      return {
        engine: `${base}MergeTree`,
        aggregates: nullable.map((c) => `count(${quoted(c.name)}) > 0`),
        describe: nullable.length > 0 ? `which of ${nullable.map((c) => c.name).join(", ")} hold a value` : "the keys",
      };
    }
    default:
      return undefined;
  }
}
