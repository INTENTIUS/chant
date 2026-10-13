import { describe, test, expect } from "vitest";
import * as ts from "typescript";
import { flatDeclarationsRule } from "./flat-declarations";
import { noUnusedDeclarableRule } from "./no-unused-declarable";
import { fileDeclarableLimitRule } from "./file-declarable-limit";
import type { LintContext } from "../rule";

// chant #2957: a dashboard-shaped file whose panels, rows, queries and
// variables are property-kind declarables, as the grafana lexicon declares them.
const PROPERTY = new Set(["Row", "StatPanel", "TimeSeriesPanel", "PromQuery", "QueryVariable"]);

const DASHBOARD = `
import { Dashboard, Row, TimeSeriesPanel as Series, StatPanel, PromQuery, QueryVariable } from "@intentius/chant-lexicon-grafana";

export const service = new QueryVariable({ name: "service", query: "label_values(up, job)" });

export const overview = new Dashboard({
  title: "Overview",
  variables: [service],
  panels: [
    new Row({ title: "RED", panels: [
      new StatPanel({ title: "Errors", targets: [new PromQuery({ expr: "a" })], fieldConfig: { defaults: { unit: "percentunit" } }, options: { graphMode: "area" } }),
      new Series({ title: "Rate", targets: [new PromQuery({ expr: "b" }), new PromQuery({ expr: "c" })], fieldConfig: { defaults: { unit: "reqps" } } }),
      new Series({ title: "Latency", targets: [new PromQuery({ expr: "d" })], fieldConfig: { defaults: { unit: "ms" } } }),
      new Series({ title: "Saturation", targets: [new PromQuery({ expr: "e" })] }),
    ] }),
  ],
});
`;

function context(code: string, propertyClasses?: ReadonlySet<string>): LintContext {
  return {
    sourceFile: ts.createSourceFile("dashboard.ts", code, ts.ScriptTarget.Latest, true),
    entities: [],
    filePath: "dashboard.ts",
    propertyClasses,
  };
}

describe("property-kind declarables in COR001, COR004 and COR009 (chant #2957)", () => {
  test("without property classes the rules count every declarable, as before", () => {
    const ctx = context(DASHBOARD);
    expect(fileDeclarableLimitRule.check(ctx)).toHaveLength(1);
    expect(fileDeclarableLimitRule.check(ctx)[0].message).toContain("12 Declarable instances");
    expect(flatDeclarationsRule.check(ctx)).toHaveLength(4);
    expect(noUnusedDeclarableRule.check(ctx).map((d) => d.message)).toEqual([
      expect.stringContaining("'overview'"),
    ]);
  });

  test("with them, the dashboard file is clean", () => {
    const ctx = context(DASHBOARD, PROPERTY);
    expect(fileDeclarableLimitRule.check(ctx)).toEqual([]);
    expect(flatDeclarationsRule.check(ctx)).toEqual([]);
    expect(noUnusedDeclarableRule.check(ctx)).toEqual([]);
  });

  test("COR009 still counts resources, and only resources", () => {
    const resources = Array.from({ length: 9 }, (_, i) => `export const d${i} = new Dashboard({ panels: [new Row({})] });`).join("\n");
    const [diag] = fileDeclarableLimitRule.check(context(resources, PROPERTY));
    expect(diag.message).toContain("9 Declarable instances");
  });

  test("COR001 still flags inline objects on a resource", () => {
    const code = `export const d = new Dashboard({ time: { from: "now-1h", to: "now" }, panels: [new StatPanel({ options: { a: 1 } })] });`;
    const diags = flatDeclarationsRule.check(context(code, PROPERTY));
    expect(diags).toHaveLength(1);
    expect(diags[0].column).toBe(code.indexOf("{ from") + 1);
  });

  test("COR004 skips an exported property-kind declarable used from another file", () => {
    const code = `export const latency = new TimeSeriesPanel({ title: "Latency" });`;
    expect(noUnusedDeclarableRule.check(context(code, PROPERTY))).toEqual([]);
    expect(noUnusedDeclarableRule.check(context(code))).toHaveLength(1);
  });

  test("COR004 treats a resource holding a property-kind const as the root", () => {
    const code = [
      `const red = new Row({ title: "RED" });`,
      `export const overview = new Dashboard({ panels: [red] });`,
    ].join("\n");
    expect(noUnusedDeclarableRule.check(context(code, PROPERTY))).toEqual([]);
  });

  test("COR004 still flags an unreferenced resource holding no property-kind declarable", () => {
    const code = [
      `export const logs = new Bucket({ bucketName: "logs" });`,
      `export const overview = new Dashboard({ panels: [new Row({})] });`,
    ].join("\n");
    expect(noUnusedDeclarableRule.check(context(code, PROPERTY)).map((d) => d.message)).toEqual([
      expect.stringContaining("'logs'"),
    ]);
  });

  test("a namespace-qualified constructor resolves by its member name", () => {
    const code = `export const d = new g.Dashboard({ panels: [new g.StatPanel({ options: { a: 1 } })] });`;
    expect(flatDeclarationsRule.check(context(code, PROPERTY))).toEqual([]);
  });
});
