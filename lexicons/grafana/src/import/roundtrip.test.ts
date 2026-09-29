/**
 * Round trips through `chant import`.
 *
 * Dashboard JSON -> TypeScript -> `chant build` -> dashboard JSON must give
 * back the same dashboard for every fixture: Grafana 12.4.11 and 13.2.2 UI
 * exports (plain and "for sharing externally"), community dashboards from
 * grafana.com, and what this lexicon's examples build. A v2 dashboard
 * (#2947) round-trips through its classic form (./v2.ts). "The same" means
 * equal after `normalizeDashboard` (Grafana's defaults and derived keys)
 * once the importer's edits are applied to the source: every key it could
 * not carry, and every value it wrote in another form. An edit that changes
 * what Grafana does comes with an import warning, so the comparison is also
 * the check that nothing was dropped silently.
 *
 * The generated source must lint clean (COR001, COR004 and COR009 among
 * the rules), and the rebuilt dashboards must pass GRAF101-GRAF107 without
 * errors. generated-types.e2e.test.ts type-checks the generated source.
 */

import { describe, expect, test } from "vitest";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { load } from "js-yaml";
import { build } from "@intentius/chant/build";
import type { SerializerResult } from "@intentius/chant/serializer";
import type { Declarable } from "@intentius/chant/declarable";
import { lintCommand } from "@intentius/chant/cli/commands/lint";
import { importCommand, importFromContent } from "@intentius/chant/cli/commands/import";
import { grafanaSerializer } from "../serializer";
import { validateGrafanaOutput, type GrafanaIssue } from "../validate-output";
import { buildGrafana, DATASOURCES_FILE, DASHBOARD_PROVIDERS_FILE } from "../build";
import { GrafanaParser, type DashboardResourceMetadata } from "./parser";
import { GrafanaGenerator } from "./generator";
import { applyEdits } from "./edits";
import { normalizeDashboard } from "./normalize";
import { COMMUNITY, LOSSY_V1_EXPORT, UI_EXPORTS, V2_EXPORTS, exampleOutputs, projectDir, read, removeDir, writeFiles } from "./testdata/fixtures";

type Json = Record<string, unknown>;

interface Imported {
  /** Every generated file, concatenated with its path, for `toContain`. */
  source: string;
  paths: string[];
  warnings: string[];
  /** The source dashboard with the importer's edits applied. */
  expected?: Json;
  /** The rebuilt dashboard JSON text. */
  text?: string;
  rebuilt?: Json;
  files: Record<string, string>;
  buildErrors: unknown[];
  issues: GrafanaIssue[];
  lint: { errorCount: number; warningCount: number; output: string };
}

/** GRAF101-GRAF107 over a build's grafana entities, as the post-synth checks run them: declared and external datasources included. */
function checks(entities: Map<string, Declarable>): GrafanaIssue[] {
  const built = buildGrafana(new Map([...entities].filter(([, e]) => e.lexicon === "grafana")));
  return validateGrafanaOutput({
    dashboards: built.dashboards.map((d) => ({ source: d.file, json: d.json as unknown as Json })),
    datasources: built.datasources,
    externalDatasources: built.externalDatasources,
  });
}

/** Dashboard JSON (or a provisioning file) -> IR -> TypeScript -> `chant build`, and `chant lint` over the source. */
async function importAndBuild(content: string): Promise<Imported> {
  const ir = new GrafanaParser().parse(content);
  const generated = new GrafanaGenerator().generate(ir);
  const dir = projectDir();
  try {
    const srcDir = join(dir, "src");
    writeFiles(srcDir, generated);
    const result = await build(srcDir, [grafanaSerializer]);
    const lint = await lintCommand({ path: srcDir, format: "stylish" });
    const files = (result.outputs.get("grafana") as SerializerResult | undefined)?.files ?? {};
    const dashboards = Object.entries(files).filter(([f]) => f.startsWith("dashboards/"));
    const text = dashboards[0]?.[1];
    const meta = ir.resources[0]?.metadata as unknown as DashboardResourceMetadata | undefined;
    return {
      source: generated.map((f) => `// ${f.path}\n${f.content}`).join("\n"),
      paths: generated.map((f) => f.path),
      warnings: ir.warnings ?? [],
      expected: meta ? applyEdits(meta.source, meta.edits) : undefined,
      text,
      rebuilt: text === undefined ? undefined : (JSON.parse(text) as Json),
      files,
      buildErrors: result.errors,
      issues: checks(result.entities),
      lint: { errorCount: lint.errorCount, warningCount: lint.warningCount, output: lint.output },
    };
  } finally {
    removeDir(dir);
  }
}

/** Import, build, and expect the same dashboard back, lint-clean source and no check errors. */
async function expectRoundTrip(content: string): Promise<Imported> {
  const out = await importAndBuild(content);
  expect(out.buildErrors).toEqual([]);
  expect(out.rebuilt).toBeDefined();
  expect(normalizeDashboard(out.rebuilt!)).toEqual(normalizeDashboard(out.expected!));
  expect(out.lint.errorCount + out.lint.warningCount, out.lint.output).toBe(0);
  expect(out.issues.filter((i) => i.severity === "error")).toEqual([]);
  return out;
}

describe("dashboard JSON -> TypeScript -> dashboard JSON", () => {
  test("a custom variable in Grafana's `text : value` syntax, with an escaped comma and no current (#2944)", async () => {
    const dashboard = {
      uid: "kv",
      title: "KV",
      schemaVersion: 42,
      panels: [],
      templating: { list: [{ type: "custom", name: "env", query: "Production : prod,Staging : stg,a\\,b" }] },
    };
    const out = await expectRoundTrip(JSON.stringify(dashboard));
    const env = (out.rebuilt!.templating as { list: Json[] }).list[0];
    expect(env.query).toBe("Production : prod,Staging : stg,a\\,b");
    expect(env.current).toEqual({ text: "Production", value: "prod" });
    expect(env.options).toEqual([
      { selected: true, text: "Production", value: "prod" },
      { selected: false, text: "Staging", value: "stg" },
      { selected: false, text: "a,b", value: "a,b" },
    ]);
  });

  for (const file of UI_EXPORTS) {
    test(`Grafana UI export ${file}`, async () => {
      const out = await expectRoundTrip(read(file));
      // What Grafana exported passes every check once rebuilt, schema included. The one finding left is
      // GRAF101 saying it cannot check a dashboard that names its datasources only through variables.
      expect(out.issues.filter((i) => !(i.code === "GRAF101" && i.severity === "warning" && i.message.includes("cannot check")))).toEqual([]);
      expect(out.paths.every((p) => p.startsWith("chant-fx-"))).toBe(true);
      // The ad hoc filter and the annotation are named, not dropped silently.
      if (file.includes("checkout")) {
        expect(out.warnings).toContainEqual(expect.stringContaining('variable "Filters" (adhoc) is not carried'));
        expect(out.warnings).toContainEqual(expect.stringContaining('the annotation "Deploys"'));
        expect(out.source).toContain("repeat: env,");
        expect(out.source).toContain("collapsed: true,");
      } else if (file.includes("slo")) {
        expect(out.warnings).toContainEqual(expect.stringMatching(/is a library panel \("Burn rate", uid chant-fx-burn\)/));
      }
      // A library panel, and the models an external export carries in __elements, are named.
      const source = JSON.parse(read(file)) as Json;
      const libraryPanels = (source.panels as Json[]).filter((p) => p.libraryPanel !== undefined).length;
      expect(out.warnings.filter((w) => w.includes("is a library panel")).length).toBe(libraryPanels);
      if (source.__elements && Object.keys(source.__elements as Json).length > 0) {
        expect(out.warnings).toContain("dashboard: __elements is not carried (the library panels exported with it; library panels are not carried yet)");
      }
      if (file.includes(".external.")) {
        expect(out.warnings).toContainEqual(expect.stringMatching(/^__inputs: DS_PROMETHEUS \(prometheus\)/));
        expect(out.source).toContain("const dsPrometheus = new DatasourceVariable({");
      }
    });
  }

  for (const file of V2_EXPORTS) {
    test(`v2 dashboard ${file}, through its classic form`, async () => {
      const out = await expectRoundTrip(read(file));
      expect(out.paths.every((p) => /^chant-fx-(checkout|tabs)\//.test(p))).toBe(true);
      expect(out.warnings[0]).toMatch(/^This is a v2 dashboard \(dashboard\.grafana\.app\/v2\)\./);
      if (file.includes("tabs")) {
        // Tabs become rows, and the auto grid's panels keep the positions Grafana gives them.
        expect(out.warnings).toContainEqual(expect.stringMatching(/tabs "Overview" and "Details" become expanded rows/));
        expect((out.rebuilt!.panels as Json[]).filter((p) => p.type === "row").map((p) => p.title)).toEqual(["Overview", "Details", "Latency ($env)", "Logs"]);
      }
    });
  }

  test("datasources the dashboard names by uid become ExternalDatasources, and every check passes", async () => {
    for (const file of ["exports/grafana-12.4.11/checkout.json", "exports/grafana-12.4.11/slo.json", "exports/grafana-13.2.2/slo.json"]) {
      const out = await expectRoundTrip(read(file));
      expect(out.issues, file).toEqual([]);
      expect(out.source).toContain('const prom = new ExternalDatasource({ type: "prometheus", uid: "prom" });');
    }
    // The 12.4.11 export's datasource variable has prom selected: that is where the Prometheus uid comes from.
    expect((await importAndBuild(read("exports/grafana-12.4.11/checkout.json"))).source).toContain('const loki = new ExternalDatasource({ type: "loki", uid: "loki" });');
  });

  test("when a datasource variable's type is named by no uid, the uids stay plain refs and the warning says why", async () => {
    const out = await expectRoundTrip(read("exports/grafana-13.2.2/checkout.json"));
    expect(out.source).toContain('const loki: DatasourceRef<"loki"> = { type: "loki", uid: "loki" };');
    expect(out.warnings).toContainEqual(expect.stringMatching(/^datasources: the dashboard names "loki" \(loki\) by uid, but no prometheus datasource, which \$datasource \(prometheus\) chooses among/));
  });

  test("an __inputs constant is filled in, and __inputs datasources become variables", async () => {
    const out = await expectRoundTrip(read("exports/grafana-12.4.11/checkout.external.json"));
    expect(out.warnings).toContain(
      '__inputs: the constant VAR_SERVICE is written as its value "checkout", the value Grafana\'s import dialog fills in',
    );
    expect(out.source).toContain('const service = new ConstantVariable({ name: "service", skipUrlSync: true, value: "checkout" });');
    // Every ${DS_LOKI} still resolves: the rebuilt dashboard declares it.
    const list = (out.rebuilt!.templating as { list: Json[] }).list;
    expect(list.slice(0, 2).map((v) => [v.name, v.type, v.query])).toEqual([
      ["DS_PROMETHEUS", "datasource", "prometheus"],
      ["DS_LOKI", "datasource", "loki"],
    ]);
    expect(out.text).toContain('"uid": "${DS_LOKI}"');
    expect(out.text).not.toContain("__inputs");
  });

  for (const file of COMMUNITY) {
    test(`grafana.com dashboard ${file}`, async () => {
      const out = await expectRoundTrip(read(file));
      // Every datasource reference resolved to a variable or a ref.
      expect(out.warnings.join("\n")).not.toMatch(/: datasource is not carried/);
    });
  }

  test("Node Exporter Full keeps its 30-odd rows and every panel id", async () => {
    const out = await expectRoundTrip(read("community/node-exporter-full.json"));
    const source = JSON.parse(read("community/node-exporter-full.json")) as { panels: Json[] };
    const ids = (panels: Json[]): unknown[] => panels.flatMap((p) => [p.id, ...ids((p.panels as Json[] | undefined) ?? [])]);
    expect(ids(out.rebuilt!.panels as Json[])).toEqual(ids(source.panels));
    // Split at eight declarables per module, a panel kept with its queries.
    expect(out.paths.filter((p) => p.includes("/row-")).length).toBeGreaterThan(30);
  });

  test("a panel type chant ships a class for is declared with it", async () => {
    const out = await expectRoundTrip(read("community/traefik.json"));
    expect(out.source).toMatch(/new PieChartPanel\(\{/);
    expect(out.source).not.toContain("definePanel");
  });

  test("every built-in panel type in a UI export is declared with its class", async () => {
    const out = await expectRoundTrip(read("exports/grafana-12.4.11/panels.json"));
    for (const cls of ["BarChartPanel", "BarGaugePanel", "PieChartPanel", "StateTimelinePanel", "StatusHistoryPanel", "HistogramPanel", "NodeGraphPanel", "XYChartPanel", "TrendPanel", "CanvasPanel", "GeomapPanel", "FlameGraphPanel", "AlertListPanel", "TracesPanel"]) {
      expect(out.source).toMatch(new RegExp(`new ${cls}\\(\\{`));
    }
    expect(out.source).not.toContain("definePanel");
    expect(out.warnings).toEqual([]);
  });

  test("a panel type chant has no class for goes through definePanel", async () => {
    // The Traefik dashboard with its pie chart swapped for a community plugin chant does not ship.
    const out = await expectRoundTrip(read("community/traefik.json").split('"type": "piechart"').join('"type": "grafana-polystat-panel"'));
    expect(out.source).toContain("const GrafanaPolystatPanelPanel = definePanel()({");
    expect(out.source).toContain('import { GrafanaPolystatPanelPanel } from "./plugins";');
    expect(out.source).toMatch(/new GrafanaPolystatPanelPanel\(\{/);
  });

  test("an AngularJS-era dashboard: schemaVersion carried, top-level panel settings named", async () => {
    const out = await expectRoundTrip(read("community/prometheus-2-stats.json"));
    expect(out.rebuilt!.schemaVersion).toBe(18);
    expect(out.source).toContain("schemaVersion: 18,");
    expect(out.warnings[1]).toMatch(/^13 panels are AngularJS panels \(graph, singlestat\) that keep their settings as top-level keys/);
    expect(out.warnings).toContainEqual(expect.stringMatching(/^panel "WAL Corruptions" \(id 37\): colorBackground, .* are not carried \(no prop takes them\)$/));
    // Its datasources are names ("${DS_PROMETHEUS}"), written as refs to the __inputs variable.
    expect(out.text).toContain('"uid": "${DS_PROMETHEUS}"');
  });

  test("the same dashboard after Grafana 12.4.11 migrated it imports with no warnings", async () => {
    const out = await expectRoundTrip(read("community/prometheus-2-stats.grafana-12.4.11.json"));
    expect(out.warnings).toEqual([]);
    expect(out.source).toContain('const prom = new ExternalDatasource({ type: "prometheus", uid: "prom" });');
  });

  test("what the examples build comes back as the same text", async () => {
    const outputs = (await exampleOutputs()).filter(([f]) => /^[^/]+\/dashboards\/.*\.json$/.test(f));
    expect(outputs.length).toBeGreaterThan(3);
    for (const [name, text] of outputs) {
      const out = await expectRoundTrip(text);
      expect(out.warnings, name).toEqual([]);
      expect(out.text, name).toBe(text);
    }
  }, 60_000);
});

describe("provisioning files", () => {
  test("a datasource provisioning file becomes Datasources and builds back to the same file", async () => {
    const [, yaml] = (await exampleOutputs()).find(([f]) => f === `getting-started/${DATASOURCES_FILE}`)!;
    const out = await importAndBuild(yaml);
    expect(out.warnings).toEqual([]);
    expect(out.buildErrors).toEqual([]);
    expect(out.source).toContain("const tempo = new Datasource({");
    expect(load(out.files[DATASOURCES_FILE])).toEqual(load(yaml));
    expect(out.lint.errorCount + out.lint.warningCount, out.lint.output).toBe(0);
  });

  test("a dashboard provisioning file becomes DashboardProviders", async () => {
    const yaml = [
      "apiVersion: 1",
      "providers:",
      "  - name: platform",
      "    orgId: 1",
      "    folder: Platform",
      "    type: file",
      "    disableDeletion: true",
      "    allowUiUpdates: false",
      "    updateIntervalSeconds: 60",
      "    options:",
      "      path: /var/lib/grafana/dashboards/platform",
      "      foldersFromFilesStructure: false",
      "",
    ].join("\n");
    const out = await importAndBuild(yaml);
    expect(out.warnings).toEqual([]);
    expect(out.buildErrors).toEqual([]);
    expect(out.source).toContain("new DashboardProvider({");
    expect(load(out.files[DASHBOARD_PROVIDERS_FILE] ?? "")).toEqual(load(yaml));
  });
});

// ── through core's import command ───────────────────────────────────

describe("chant import dashboard.json", () => {
  for (const lexicon of [undefined, "grafana"]) {
    test(lexicon ? "with --lexicon grafana" : "detected as a Grafana dashboard in a project that lists grafana", async () => {
      const dir = projectDir();
      try {
        const templatePath = join(dir, "checkout.json");
        const content = read("exports/grafana-13.2.2/checkout.external.json");
        writeFiles(dir, [{ path: "checkout.json", content }]);
        const output = join(dir, "src");
        const result = await importCommand({ templatePath, output, force: true, lexicon });
        expect(result.error).toBeUndefined();
        expect(result.success).toBe(true);
        expect(result.lexicon).toBe("grafana");
        expect(result.generatedFiles).toEqual([
          "chant-fx-checkout/variables.ts",
          "chant-fx-checkout/panels.ts",
          "chant-fx-checkout/row-details-for-job.ts",
          "chant-fx-checkout/dashboard.ts",
        ]);
        expect(result.warnings).toContainEqual(expect.stringContaining('variable "Filters" (adhoc) is not carried'));
        const built = await build(output, [grafanaSerializer]);
        expect(built.errors).toEqual([]);
        const text = (built.outputs.get("grafana") as SerializerResult).files!["dashboards/chant-fx-checkout.json"];
        const ir = new GrafanaParser().parse(content);
        const meta = ir.resources[0].metadata as unknown as DashboardResourceMetadata;
        expect(normalizeDashboard(JSON.parse(text))).toEqual(normalizeDashboard(applyEdits(meta.source, meta.edits)));
      } finally {
        removeDir(dir);
      }
    });
  }

  test("a v2 dashboard is imported, and builds back to its classic form", async () => {
    const dir = projectDir();
    try {
      const output = join(dir, "src");
      const content = read(V2_EXPORTS[1]);
      const result = await importFromContent({ content, lexicon: "grafana", output });
      expect(result.error).toBeUndefined();
      expect(result.generatedFiles).toContain("chant-fx-tabs/dashboard.ts");
      expect(result.warnings[0]).toMatch(/^This is a v2 dashboard \(dashboard\.grafana\.app\/v2\)\./);
      const built = await build(output, [grafanaSerializer]);
      expect(built.errors).toEqual([]);
      const text = (built.outputs.get("grafana") as SerializerResult).files!["dashboards/chant-fx-tabs.json"];
      const meta = new GrafanaParser().parse(content).resources[0].metadata as unknown as DashboardResourceMetadata;
      expect(normalizeDashboard(JSON.parse(text))).toEqual(normalizeDashboard(applyEdits(meta.source, meta.edits)));
    } finally {
      removeDir(dir);
    }
  });

  test("a v1 read of a dashboard Grafana stores as v2 is refused, and nothing is written", async () => {
    const dir = projectDir();
    try {
      const output = join(dir, "src");
      const result = await importFromContent({ content: read(LOSSY_V1_EXPORT), lexicon: "grafana", output });
      expect(result.success).toBe(true);
      expect(result.generatedFiles).toEqual([]);
      expect(result.warnings).toEqual([expect.stringMatching(/^Not imported: Grafana stores this dashboard as v2 /)]);
      expect(existsSync(join(output, "chant-fx-tabs"))).toBe(false);
    } finally {
      removeDir(dir);
    }
  });

  test("detection picks the v2 dashboard up too", async () => {
    const dir = projectDir();
    try {
      const templatePath = join(dir, "checkout.v2.json");
      writeFiles(dir, [{ path: "checkout.v2.json", content: read(V2_EXPORTS[0]) }]);
      const result = await importCommand({ templatePath, output: join(dir, "src"), force: true });
      expect(result.lexicon).toBe("grafana");
      expect(result.warnings.join("\n")).toContain("v2 dashboard");
      expect(result.generatedFiles).toContain("chant-fx-checkout/dashboard.ts");
    } finally {
      removeDir(dir);
    }
  });

  test("two dashboards imported into one project build together", async () => {
    const dir = projectDir();
    try {
      const output = join(dir, "src");
      for (const file of ["community/redis.json", "exports/grafana-13.2.2/slo.json"]) {
        const result = await importFromContent({ content: read(file), lexicon: "grafana", output, force: true });
        expect(result.success).toBe(true);
      }
      const built = await build(output, [grafanaSerializer]);
      expect(built.errors).toEqual([]);
      const files = Object.keys((built.outputs.get("grafana") as SerializerResult).files ?? {});
      expect(files.filter((f) => f.startsWith("dashboards/")).sort()).toEqual(["dashboards/chant-fx-slo.json", "dashboards/e008bc3f-81a2-40f9-baf2-a33fd8dec7ec.json"]);
      expect(readFileSync(join(output, "chant-fx-slo", "dashboard.ts"), "utf-8")).toContain('uid: "chant-fx-slo"');
    } finally {
      removeDir(dir);
    }
  });
});
