/**
 * The correction overlay (chant #2939): real Grafana 12.4 and 13.x exports
 * pass GRAF107, the reproductions from the issue type and build, unknown keys
 * are warnings, and genuine type violations stay errors.
 */
import { describe, expect, test } from "vitest";
import { readdirSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { SCHEMA_NAMES } from "./pin";
import { applyOverlay, loadOverlay, type SchemaOverlay } from "./spec/overlay";
import { loadSchema, loadVendoredSchema } from "./spec/schemas";
import { validateDashboardSchema } from "./schema-validate";
import { checkSchema } from "./validate-output";
import { renderDashboard } from "./build";
import { Dashboard } from "./dashboard";
import { TablePanel, TimeSeriesPanel } from "./panels";
import { PromQuery } from "./query";
import { Datasource } from "./datasource";

const pkgDir = dirname(dirname(fileURLToPath(import.meta.url)));
const exportsDir = join(pkgDir, "test", "fixtures", "exports");

type Json = Record<string, unknown>;

function readJson(path: string): Json {
  return JSON.parse(readFileSync(path, "utf-8")) as Json;
}

const versions = readdirSync(exportsDir).filter((d) => d.startsWith("grafana-"));
const classicExports = versions.flatMap((v) =>
  readdirSync(join(exportsDir, v))
    .filter((f) => f.endsWith(".json") && !f.includes("v2-resource"))
    .map((f) => [`${v}/${f}`, join(exportsDir, v, f)] as const),
);

describe("the overlay files", () => {
  test("every patch cites its Grafana source and says why", () => {
    for (const name of SCHEMA_NAMES) {
      const overlay = loadOverlay(name);
      if (!overlay) continue;
      expect(overlay.grafana).toMatch(/^v\d+\.\d+\.\d+$/);
      for (const p of overlay.patches) {
        expect({ path: p.path, source: p.source }).toEqual({ path: p.path, source: expect.stringMatching(/\.(cue|ts):\d+/) });
        expect(p.why.length).toBeGreaterThan(0);
      }
    }
  });

  test("the dashboard, timeseries and logs schemas are patched; the vendored bytes are not", () => {
    expect(SCHEMA_NAMES.filter((n) => loadOverlay(n))).toEqual(["dashboard", "timeseries", "logs"]);
    const vendored = loadVendoredSchema("dashboard").definitions as Record<string, Json>;
    const patched = loadSchema("dashboard").definitions as Record<string, Json>;
    expect((vendored.MatcherConfig.properties as Json).scope).toBeUndefined();
    expect((patched.MatcherConfig.properties as Json).scope).toEqual(expect.objectContaining({ $ref: "#/definitions/MatcherScope" }));
  });

  test("applying refuses a patch the vendored schema already carries, or a path it lacks", () => {
    const base = { definitions: { A: { properties: { x: { type: "string" } } } } };
    const overlay = (patches: SchemaOverlay["patches"]): SchemaOverlay => ({ schema: "dashboard", grafana: "v13.2.2", patches });
    const cite = { source: "kinds/dashboard/dashboard_kind.cue:1", why: "test" };
    expect(() => applyOverlay(base, overlay([{ op: "add", path: "/definitions/A/properties/x", value: {}, ...cite }]))).toThrow(/already present/);
    expect(() => applyOverlay(base, overlay([{ op: "replace", path: "/definitions/A/properties/y", value: {}, ...cite }]))).toThrow(/not present/);
    expect(() => applyOverlay(base, overlay([{ op: "remove", path: "/definitions/B/properties", ...cite }]))).toThrow(/no parent/);
    const out = applyOverlay(base, overlay([{ op: "add", path: "/definitions/A/properties/y", value: { type: "number" }, ...cite }]));
    expect(out).toEqual({ definitions: { A: { properties: { x: { type: "string" }, y: { type: "number" } } } } });
    expect(base.definitions.A.properties).toEqual({ x: { type: "string" } });
  });
});

describe("real Grafana exports", () => {
  test("the corpus covers Grafana 12.4 and 13.2, plain and shared externally", () => {
    expect(versions).toEqual(["grafana-12.4.11", "grafana-13.2.2"]);
    expect(classicExports.map(([name]) => name)).toEqual(
      expect.arrayContaining(["grafana-12.4.11/checkout.external.json", "grafana-13.2.2/slo.external.json", "grafana-13.2.2/checkout.json"]),
    );
  });

  test.each(classicExports)("%s passes GRAF107 with no errors or warnings", (name, path) => {
    const json = readJson(path);
    expect({ name, problems: validateDashboardSchema(json) }).toEqual({ name, problems: [] });
    expect(checkSchema({ dashboards: [{ source: name, json }], datasources: [] })).toEqual([]);
  });

  test("the external exports carry the metadata the overlay allows", () => {
    const json = readJson(join(exportsDir, "grafana-13.2.2", "slo.external.json"));
    expect(Object.keys(json)).toEqual(expect.arrayContaining(["__inputs", "__requires", "__elements"]));
    expect(Object.keys(json.__elements as Json)).toEqual(["chant-fx-burn"]);
  });
});

describe("the issue's reproductions", () => {
  const prometheus = new Datasource({ name: "Prometheus", type: "prometheus" });
  const rate = new PromQuery({ expr: "sum(rate(http_requests_total[5m]))" });

  test("a byName matcher with a string option and a data link with only title and url type, build and pass", () => {
    const panel = new TimeSeriesPanel({
      title: "Requests",
      datasource: prometheus,
      targets: [rate],
      fieldConfig: {
        defaults: { links: [{ title: "Runbook", url: "https://example.com/runbook" }] },
        overrides: [
          { matcher: { id: "byName", options: "requests" }, properties: [{ id: "unit", value: "reqps" }] },
          { matcher: { id: "byType", options: "number", scope: "series" }, properties: [{ id: "decimals", value: 1 }] },
        ],
      },
      links: [{ title: "Traces", url: "https://example.com/traces", targetBlank: true }],
    });
    const json = renderDashboard(new Dashboard({ title: "Repro", uid: "repro", panels: [panel] })) as unknown as Json;
    expect(validateDashboardSchema(json)).toEqual([]);
  });

  test("a table cellOptions matching several variants is accepted", () => {
    const panel = new TablePanel({ title: "T", fieldConfig: { defaults: { custom: { cellOptions: { type: "auto" } } } } });
    const json = renderDashboard(new Dashboard({ title: "Table", uid: "table", panels: [panel] })) as unknown as Json;
    expect(validateDashboardSchema(json)).toEqual([]);
  });
});

describe("errors and warnings", () => {
  function dashboard(extra: Json = {}, panel: Json = {}): Json {
    return {
      uid: "d",
      title: "D",
      schemaVersion: 42,
      panels: [{ type: "timeseries", id: 1, gridPos: { x: 0, y: 0, w: 12, h: 8 }, fieldConfig: { defaults: {}, overrides: [] }, ...panel }],
      ...extra,
    };
  }

  test("a key the pin does not know is a warning, wherever it is", () => {
    const problems = validateDashboardSchema(
      dashboard({ fancyNewField: true }, { fieldConfig: { defaults: { custom: { brandNewOption: 1 } }, overrides: [] } }),
    );
    expect(problems).toEqual([
      { path: "/", message: 'unknown key "fancyNewField" (not in the pinned schema)', severity: "warning" },
      { path: "/panels/0/fieldConfig/defaults/custom", message: 'unknown key "brandNewOption" (not in the pinned schema)', severity: "warning" },
    ]);
  });

  test("a genuine type violation stays an error", () => {
    const problems = validateDashboardSchema(
      dashboard(
        { templating: { list: [{ type: "query", name: "q", query: 5 }] } },
        { fieldConfig: { defaults: {}, overrides: [{ matcher: { id: 7, scope: "everything" }, properties: [] }] }, links: [{ url: "x" }] },
      ),
    );
    expect(problems.filter((p) => p.severity === "error").map((p) => `${p.path}: ${p.message}`)).toEqual(
      expect.arrayContaining([
        "/templating/list/0/query: must be string",
        "/templating/list/0/query: must be object",
        "/panels/0/links/0: must have required property 'title'",
        "/panels/0/fieldConfig/overrides/0/matcher/id: must be string",
        expect.stringMatching(/^\/panels\/0\/fieldConfig\/overrides\/0\/matcher\/scope: must be equal to one of the allowed values/),
      ]),
    );
    expect(problems.every((p) => p.severity === "error")).toBe(true);
  });

  test("a panel with neither a type nor a library panel is an error; a library panel reference is fine", () => {
    const bare = validateDashboardSchema({ uid: "d", title: "D", schemaVersion: 42, panels: [{ id: 1, gridPos: { x: 0, y: 0, w: 6, h: 6 } }] });
    expect(bare.map((p) => [p.severity, p.message])).toEqual([
      ["error", "must have required property 'type'"],
      ["error", "must have required property 'libraryPanel'"],
    ]);
    const lib = { id: 1, gridPos: { x: 0, y: 0, w: 6, h: 6 }, libraryPanel: { uid: "u", name: "n" } };
    expect(validateDashboardSchema({ uid: "d", title: "D", schemaVersion: 42, panels: [lib] })).toEqual([]);
  });

  test("GRAF107 carries the severity through", () => {
    const issues = checkSchema({ dashboards: [{ json: dashboard({ fancyNewField: true, graphTooltip: 7 }) }], datasources: [] });
    expect(issues.map((i) => [i.code, i.severity])).toEqual([
      ["GRAF107", "error"],
      ["GRAF107", "warning"],
    ]);
  });
});
