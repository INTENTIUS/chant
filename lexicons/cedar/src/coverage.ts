/**
 * Schema coverage for the cedar lexicon.
 *
 * Core's `computeCoverage` measures CloudFormation-shaped dimensions —
 * property constraints, create-only/write-only lifecycle, return attributes —
 * none of which a Cedar schema has. Reporting 0% across four axes that cannot
 * apply would be worse than reporting nothing, so this asks the question that
 * does mean something here: **is every entity type and every action in the
 * schema reachable from the generated artifacts?**
 *
 * A gap is a real defect, not a nice-to-have. An action with no generated
 * constant is an action a policy can only name as a hand-typed string, which
 * is the exact failure mode the lexicon exists to remove.
 */

import { existsSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { LEXICON_JSON_FILENAME } from "./codegen/generate";
import { attributesTypeName, contextTypeName } from "./codegen/emit";
import { readSchemaSource, type ResolveSchemaOptions } from "./spec/fetch";
import { parseCedarSchema } from "./spec/parse";

export interface CedarCoverageItem {
  /** Fully-qualified declaration name from the schema. */
  name: string;
  kind: "entity" | "action";
  /** True when a registry entry names this declaration. */
  covered: boolean;
  /** True when the record type beside it (attributes / context) is present too. */
  recordCovered: boolean;
  /** Attributes the schema declares for it. */
  attributes: number;
}

export interface CedarCoverageReport {
  /** Where the schema came from. */
  schemaPath: string;
  /** True when the bundled default schema was used. */
  isDefaultSchema: boolean;
  entityTypes: number;
  entityTypesCovered: number;
  actions: number;
  actionsCovered: number;
  recordTypes: number;
  recordTypesCovered: number;
  entityPct: number;
  actionPct: number;
  recordPct: number;
  overallPct: number;
  items: CedarCoverageItem[];
}

export interface CedarCoverageOptions extends ResolveSchemaOptions {
  /** Directory holding the generated artifacts. Defaults to `<package>/src/generated`. */
  generatedDir?: string;
  verbose?: boolean;
  /** Fail when `overallPct` falls below this. */
  minOverall?: number;
}

function defaultGeneratedDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "generated");
}

function pct(covered: number, total: number): number {
  return total === 0 ? 100 : Math.round((covered / total) * 100);
}

/** Compute schema coverage against the artifacts already on disk. */
export function computeCedarCoverage(options: CedarCoverageOptions = {}): CedarCoverageReport {
  const generatedDir = options.generatedDir ?? defaultGeneratedDir();
  const registryPath = join(generatedDir, LEXICON_JSON_FILENAME);

  const covered = new Set<string>();
  if (existsSync(registryPath)) {
    const registry = JSON.parse(readFileSync(registryPath, "utf-8")) as Record<string, { resourceType?: string }>;
    for (const entry of Object.values(registry)) {
      if (entry.resourceType) covered.add(entry.resourceType);
    }
  }

  const source = readSchemaSource(options);
  const { decls } = parseCedarSchema(source.text);

  const items: CedarCoverageItem[] = decls
    .map((decl) => {
      const recordName =
        decl.kind === "entity" ? attributesTypeName(decl.typeName) : contextTypeName(decl.typeName);
      return {
        name: decl.typeName,
        kind: decl.kind,
        covered: covered.has(decl.typeName),
        recordCovered: covered.has(recordName),
        attributes: decl.kind === "entity" ? decl.attributes.length : decl.context.length,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const entities = items.filter((i) => i.kind === "entity");
  const actions = items.filter((i) => i.kind === "action");
  const entityTypesCovered = entities.filter((i) => i.covered).length;
  const actionsCovered = actions.filter((i) => i.covered).length;
  const recordTypesCovered = items.filter((i) => i.recordCovered).length;

  const entityPct = pct(entityTypesCovered, entities.length);
  const actionPct = pct(actionsCovered, actions.length);
  const recordPct = pct(recordTypesCovered, items.length);

  return {
    schemaPath: source.path,
    isDefaultSchema: source.isDefault,
    entityTypes: entities.length,
    entityTypesCovered,
    actions: actions.length,
    actionsCovered,
    recordTypes: items.length,
    recordTypesCovered,
    entityPct,
    actionPct,
    recordPct,
    overallPct: Math.round((entityPct + actionPct + recordPct) / 3),
    items,
  };
}

/** Human-readable summary. */
export function formatCedarCoverage(report: CedarCoverageReport, verbose = false): string {
  const lines = [
    `Cedar schema coverage — ${report.isDefaultSchema ? "bundled default schema" : report.schemaPath}`,
    `  Entity types: ${report.entityTypesCovered}/${report.entityTypes} (${report.entityPct}%)`,
    `  Actions:      ${report.actionsCovered}/${report.actions} (${report.actionPct}%)`,
    `  Record types: ${report.recordTypesCovered}/${report.recordTypes} (${report.recordPct}%)`,
    `  Overall:      ${report.overallPct}%`,
  ];

  if (verbose) {
    lines.push("");
    for (const item of report.items) {
      const gaps: string[] = [];
      if (!item.covered) gaps.push("no generated declaration");
      if (!item.recordCovered) gaps.push(item.kind === "entity" ? "no attributes type" : "no context type");
      lines.push(
        gaps.length === 0
          ? `  ${item.name}: covered (${item.attributes} attribute(s))`
          : `  ${item.name}: ${gaps.join(", ")}`,
      );
    }
  }

  return lines.join("\n");
}

/**
 * Print the report, and throw when it falls below `minOverall`.
 */
export function analyzeCedarCoverage(options: CedarCoverageOptions = {}): CedarCoverageReport {
  const report = computeCedarCoverage(options);
  console.error(formatCedarCoverage(report, options.verbose));

  if (options.minOverall !== undefined && report.overallPct < options.minOverall) {
    throw new Error(`Cedar schema coverage ${report.overallPct}% is below the ${options.minOverall}% minimum`);
  }

  return report;
}
