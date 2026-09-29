/**
 * Validate the grafana lexicon's own artifacts: the vendored schemas match
 * their pinned digests, the committed schema types match what generate would
 * write, every required class is in the registry, and every built-in panel
 * renders to a dashboard the pinned schema accepts.
 */

import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import type { ValidateCheck, ValidateResult } from "@intentius/chant/codegen/validate";
import { BUILTIN_CATALOG, lexiconRegistry } from "./catalog";
import { digestMismatches } from "./spec/schemas";
import { schemaModules } from "./codegen/generate";
import * as panels from "./panels";
import { Dashboard } from "./dashboard";
import { renderDashboard } from "./build";
import { validateDashboardSchema } from "./schema-validate";

export type { ValidateCheck, ValidateResult } from "@intentius/chant/codegen/validate";

/** Every entity class the package must keep exporting. */
export const REQUIRED_NAMES = [
  "Dashboard",
  "Datasource",
  "ExternalDatasource",
  "DashboardProvider",
  "DatasourceProvisioning",
  "Folder",
  "Row",
  "TimeSeriesPanel",
  "StatPanel",
  "GaugePanel",
  "TablePanel",
  "LogsPanel",
  "TracesPanel",
  "HeatmapPanel",
  "TextPanel",
  "BarChartPanel",
  "BarGaugePanel",
  "PieChartPanel",
  "StateTimelinePanel",
  "StatusHistoryPanel",
  "HistogramPanel",
  "NodeGraphPanel",
  "XYChartPanel",
  "TrendPanel",
  "CanvasPanel",
  "GeomapPanel",
  "FlameGraphPanel",
  "AlertListPanel",
  "PromQuery",
  "TempoQuery",
  "LokiQuery",
  "ElasticsearchQuery",
  "CloudWatchQuery",
  "AzureMonitorQuery",
  "CloudMonitoringQuery",
  "BigQueryQuery",
  "PyroscopeQuery",
  "PostgresQuery",
  "MySQLQuery",
  "MSSQLQuery",
  "QueryVariable",
  "CustomVariable",
  "IntervalVariable",
  "DatasourceVariable",
  "ConstantVariable",
  "TextboxVariable",
];

const pkgDir = dirname(dirname(fileURLToPath(import.meta.url)));

export async function validate(): Promise<ValidateResult> {
  const checks: ValidateCheck[] = [];
  const registry = lexiconRegistry();

  const missing = REQUIRED_NAMES.filter((n) => !(n in registry));
  checks.push(
    missing.length === 0
      ? { name: "required-names", ok: true }
      : { name: "required-names", ok: false, error: `Missing required names: ${missing.join(", ")}` },
  );

  const bad = digestMismatches();
  checks.push(
    bad.length === 0
      ? { name: "schemas-match-pin", ok: true }
      : { name: "schemas-match-pin", ok: false, error: `Vendored schemas differ from GRAFANA_SCHEMA_PIN: ${bad.map((b) => b.name).join(", ")}` },
  );

  const stale = Object.entries(schemaModules())
    .filter(([rel, source]) => {
      try {
        return readFileSync(join(pkgDir, rel), "utf-8") !== source;
      } catch {
        return true;
      }
    })
    .map(([rel]) => rel);
  checks.push(
    stale.length === 0
      ? { name: "schema-types-in-sync", ok: true }
      : { name: "schema-types-in-sync", ok: false, error: `Run npm run generate: stale ${stale.join(", ")}` },
  );

  const classes = (Object.entries(panels) as Array<[string, unknown]>).filter(
    (e): e is [string, panels.PanelClass] => typeof e[1] === "function" && "definition" in (e[1] as object),
  );
  const broken: string[] = [];
  for (const [name, Cls] of classes) {
    try {
      const json = renderDashboard(new Dashboard({ title: name, uid: "validate", panels: [new Cls({ title: name })] }));
      const problems = validateDashboardSchema(json as unknown as Record<string, unknown>);
      if (problems.length > 0) broken.push(`${name} (${problems[0].path}: ${problems[0].message})`);
    } catch (err) {
      broken.push(`${name} (${err instanceof Error ? err.message : String(err)})`);
    }
  }
  checks.push(
    broken.length === 0
      ? { name: "panels-match-schema", ok: true }
      : { name: "panels-match-schema", ok: false, error: `Panels whose dashboard fails the schema: ${broken.join(", ")}` },
  );

  checks.push(
    BUILTIN_CATALOG.length === Object.keys(registry).length
      ? { name: "catalog-matches-registry", ok: true }
      : { name: "catalog-matches-registry", ok: false, error: "catalog and registry disagree" },
  );

  return { success: checks.every((c) => c.ok), checks };
}
