import { describe, expect, test } from "vitest";
import * as panels from "./panels";
import { Dashboard } from "./dashboard";
import { renderDashboard } from "./build";
import { validateDashboardSchema } from "./schema-validate";
import { SCHEMA_NAMES } from "./pin";
import { registeredQueries } from "./query";

const builtins = panels.registeredPanels().filter((d) => d.builtin);

describe("built-in panels", () => {
  test("every panel type Grafana ships with a schema at the pin has a class", () => {
    const querySchemas = new Set<string>(registeredQueries().flatMap((d) => (d.schema ? [d.schema] : [])));
    const panelSchemas = SCHEMA_NAMES.filter((n) => n !== "dashboard" && n !== "expr" && !querySchemas.has(n));
    expect(builtins.map((d) => d.schema).filter(Boolean).sort()).toEqual([...panelSchemas].sort());
  });

  test("the panels with no upstream schema are typed by hand and not validated beyond the Panel envelope", () => {
    expect(builtins.filter((d) => !d.schema).map((d) => d.type).sort()).toEqual(["alertlist", "flamegraph", "traces"]);
  });

  test("the node graph keeps Grafana's camelCase id; a plugin chant does not ship may not", () => {
    expect(panels.NodeGraphPanel.definition.type).toBe("nodeGraph");
    expect(() => panels.definePanel()({ type: "myGraph", className: "MyGraph", defaultSize: { w: 1, h: 1 } })).toThrow(/not a panel plugin id/);
  });

  test.each(builtins.map((d) => [d.className, d] as const))("%s renders a dashboard GRAF107 accepts", (_name, def) => {
    const Cls = (panels as unknown as Record<string, panels.PanelClass>)[def.className];
    const json = renderDashboard(new Dashboard({ title: def.className, panels: [new Cls({ title: "p" })] }));
    expect(json.panels![0]).toMatchObject({ type: def.type, gridPos: { w: def.defaultSize.w, h: def.defaultSize.h } });
    expect(validateDashboardSchema(json as unknown as Record<string, unknown>)).toEqual([]);
  });

  test("typed options reach the JSON, and a value the schema rejects is a GRAF107 error", () => {
    const pie = new panels.PieChartPanel({ options: { pieType: "donut", sort: "desc", displayLabels: ["percent"] } });
    const ok = renderDashboard(new Dashboard({ title: "Pie", panels: [pie] }));
    expect((ok.panels![0] as { options?: unknown }).options).toEqual({ pieType: "donut", sort: "desc", displayLabels: ["percent"] });
    expect(validateDashboardSchema(ok as unknown as Record<string, unknown>)).toEqual([]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bad = new panels.BarGaugePanel({ options: { displayMode: "sparkle" as any } });
    const problems = validateDashboardSchema(renderDashboard(new Dashboard({ title: "Bad", panels: [bad] })) as unknown as Record<string, unknown>);
    expect(problems).toEqual([expect.objectContaining({ path: "/panels/0/options/displayMode", severity: "error" })]);
  });

  test("the hand-typed alert list options type what Grafana writes", () => {
    const list = new panels.AlertListPanel({ options: { viewMode: "stat", sortOrder: 3, stateFilter: { firing: true, error: true }, folder: null } });
    expect(renderDashboard(new Dashboard({ title: "Alerts", panels: [list] })).panels![0]).toMatchObject({
      type: "alertlist",
      options: { viewMode: "stat", sortOrder: 3, stateFilter: { firing: true, error: true }, folder: null },
    });
  });
});
