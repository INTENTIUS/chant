/**
 * How much of the pinned ClickHouse catalog the dialect types beyond its name.
 *
 * Every engine, type family, codec, skip index type and setting at the pin is
 * generated as a name, so name coverage is total by construction. What varies
 * is how far the overlays go: an engine whose arguments have kinds can be
 * checked, one whose arguments are `unknown` can only be named. This reports
 * that, per section, from the generated tables.
 */

import { CODECS, SKIP_INDEX_TYPES, TABLE_ENGINES, CLICKHOUSE_VERSION } from "./generated/clickhouse";

export interface CoverageSection {
  section: string;
  total: number;
  typed: number;
  untyped: string[];
}

export interface CoverageReport {
  version: string;
  sections: CoverageSection[];
}

export function analyze(): CoverageReport {
  const engines = Object.entries(TABLE_ENGINES).filter(([, e]) => e.args !== undefined);
  const mergeTree = engines.filter(([, e]) => e.mergeTree);
  const codecs = Object.entries(CODECS).filter(([, c]) => c.role !== "internal");
  const indexes = Object.entries(SKIP_INDEX_TYPES);

  const section = (name: string, rows: Array<[string, boolean]>): CoverageSection => ({
    section: name,
    total: rows.length,
    typed: rows.filter(([, ok]) => ok).length,
    untyped: rows.filter(([, ok]) => !ok).map(([n]) => n),
  });

  return {
    version: CLICKHOUSE_VERSION,
    sections: [
      section("MergeTree engine arguments", mergeTree.map(([n, e]) => [n, e.typed])),
      section("all engine arguments", engines.map(([n, e]) => [n, e.typed])),
      section("codec parameters", codecs.map(([n, c]) => [n, c.parameters !== "unknown"])),
      section(
        "skip index parameters",
        indexes.map(([n, i]) => [n, (i.args ?? []).every((a) => a.kind !== "unknown")]),
      ),
    ],
  };
}

export function printCoverage(report: CoverageReport, opts: { verbose?: boolean; minOverall?: number } = {}): void {
  console.error(`ClickHouse ${report.version}`);
  for (const s of report.sections) {
    const pct = s.total === 0 ? 100 : Math.round((s.typed / s.total) * 100);
    console.error(`  ${s.section}: ${s.typed}/${s.total} typed (${pct}%)`);
    if (opts.verbose && s.untyped.length > 0) console.error(`    untyped: ${s.untyped.join(", ")}`);
  }
  if (opts.minOverall !== undefined) {
    const mergeTree = report.sections[0]!;
    const pct = mergeTree.total === 0 ? 100 : (mergeTree.typed / mergeTree.total) * 100;
    if (pct < opts.minOverall) throw new Error(`MergeTree argument coverage ${pct.toFixed(0)}% is below ${opts.minOverall}%`);
  }
}
