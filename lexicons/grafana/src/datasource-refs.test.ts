import { describe, expect, test } from "vitest";
import { datasourceUses, knownDatasources, resolveDatasourceRef } from "./datasource-refs";

const known = knownDatasources([{ name: "Prometheus", type: "prometheus", uid: "prom" }], [{ type: "loki", uid: "logs", name: "Logs" }]);

function dashboard(panels: unknown[], variables: unknown[] = []) {
  return { uid: "d", title: "D", panels, templating: { list: variables } };
}

describe("resolveDatasourceRef", () => {
  const vars = new Map([["ds", { type: "datasource", name: "ds", query: "prometheus" }]]);

  test("resolves provisioned and external datasources to their plugin type", () => {
    expect(resolveDatasourceRef({ uid: "prom" }, vars, known)).toMatchObject({ kind: "declared", type: "prometheus", datasource: { external: false } });
    expect(resolveDatasourceRef({ type: "loki", uid: "logs" }, vars, known)).toMatchObject({ kind: "declared", type: "loki", datasource: { external: true, name: "Logs" } });
  });

  test("resolves a datasource variable to its plugin type", () => {
    expect(resolveDatasourceRef({ uid: "${ds}" }, vars, known)).toEqual({ kind: "variable", variable: "ds", declared: true, type: "prometheus" });
    expect(resolveDatasourceRef({ type: "tempo", uid: "$other" }, vars, known)).toEqual({ kind: "variable", variable: "other", declared: false, type: "tempo" });
  });

  test("separates Grafana's pseudo-datasources, unknown uids and no ref", () => {
    expect(resolveDatasourceRef({ type: "datasource", uid: "-- Mixed --" }, vars, known).kind).toBe("builtin");
    expect(resolveDatasourceRef({ type: "prometheus", uid: "gone" }, vars, known)).toEqual({ kind: "undeclared", uid: "gone", type: "prometheus" });
    expect(resolveDatasourceRef(undefined, vars, known)).toEqual({ kind: "default" });
    expect(resolveDatasourceRef({ type: "prometheus" }, vars, known)).toEqual({ kind: "default", type: "prometheus" });
  });
});

describe("datasourceUses", () => {
  test("a query without its own ref goes where its panel's goes", () => {
    const d = dashboard([{ type: "stat", id: 1, title: "p", datasource: { uid: "prom" }, targets: [{ refId: "A", expr: "up" }, { refId: "B", datasource: { uid: "logs" } }] }]);
    const queries = datasourceUses(d, known).filter((u) => u.kind === "query");
    expect(queries.map((u) => [u.target?.refId, u.ref === undefined, u.resolved.type])).toEqual([
      ["A", true, "prometheus"],
      ["B", false, "loki"],
    ]);
  });

  test("a query under a -- Mixed -- panel with no ref goes to the default datasource", () => {
    const d = dashboard([{ type: "table", id: 1, datasource: { type: "datasource", uid: "-- Mixed --" }, targets: [{ refId: "A" }] }]);
    expect(datasourceUses(d, known).find((u) => u.kind === "query")?.resolved).toEqual({ kind: "default" });
  });

  test("covers panels in collapsed rows and query variables, and skips rows", () => {
    const d = dashboard(
      [{ type: "row", id: 1, collapsed: true, datasource: { uid: "prom" }, panels: [{ type: "stat", id: 2, datasource: { uid: "logs" }, targets: [] }] }],
      [{ type: "query", name: "job", datasource: { uid: "prom" }, query: "label_values(job)" }],
    );
    expect(datasourceUses(d, known).map((u) => [u.kind, u.where, u.resolved.type])).toEqual([
      ["panel", 'panel (untitled) (id 2)', "loki"],
      ["variable", 'variable "job"', "prometheus"],
    ]);
  });
});
