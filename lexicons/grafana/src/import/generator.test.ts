import { describe, expect, test } from "vitest";
import { GrafanaGenerator, generatePlan, DECLARABLES_PER_FILE, LINES_PER_FILE } from "./generator";
import { callValue, declRef, type Declaration, type Plan } from "./model";

function plan(declarations: Declaration[], extra: Partial<Plan> = {}): Plan {
  const keys = [...new Set(declarations.map((d) => d.module))];
  return {
    directory: "",
    modules: keys.map((key) => ({ key, file: key, summary: `The ${key}` })),
    declarations,
    customClasses: [],
    exports: ["dashboard"],
    ...extra,
  };
}

const panel = (n: number, props: Record<string, unknown> = {}, module = "panels"): Declaration => ({
  id: `panel:${n}`,
  kind: "new",
  className: "StatPanel",
  props: { title: `Panel ${n}`, ...props },
  name: `Panel ${n}`,
  module,
  unit: `panel:${n}`,
});

const query = (n: number, refId: string, module = "panels"): Declaration => ({
  id: `query:${n}:${refId}`,
  kind: "new",
  className: "PromQuery",
  props: { expr: "up", refId },
  name: { of: `panel:${n}`, suffix: refId },
  module,
  unit: `panel:${n}`,
});

const dash = (panels: string[]): Declaration => ({
  id: "dashboard",
  kind: "new",
  className: "Dashboard",
  props: { title: "D", panels: panels.map(declRef) },
  name: "D",
  module: "dashboard",
});

const file = (files: Array<{ path: string; content: string }>, path: string) => {
  const f = files.find((x) => x.path === path);
  if (!f) throw new Error(`no ${path} in ${files.map((x) => x.path).join(", ")}`);
  return f.content;
};

describe("names", () => {
  test("from titles, with a query named after its panel and refId", () => {
    const files = generatePlan(plan([query(1, "A"), panel(1, { targets: [declRef("query:1:A")] }), dash(["panel:1"])]));
    const panels = file(files, "panels.ts");
    expect(panels).toContain('const panel1A = new PromQuery({ expr: "up", refId: "A" });');
    expect(panels).toContain('const panel1 = new StatPanel({ title: "Panel 1", targets: [panel1A] });');
  });

  test("an all-caps name is one word; reserved words, clashes and leading digits are avoided", () => {
    const decls: Declaration[] = [
      { id: "variable:DS_PROMETHEUS", kind: "new", className: "DatasourceVariable", props: { name: "DS_PROMETHEUS", pluginType: "prometheus" }, name: "DS_PROMETHEUS", module: "variables" },
      { id: "variable:default", kind: "new", className: "TextboxVariable", props: { name: "default" }, name: "default", module: "variables" },
      { id: "variable:x", kind: "new", className: "TextboxVariable", props: { name: "x" }, name: "404 errors", module: "variables" },
      { id: "variable:y", kind: "new", className: "TextboxVariable", props: { name: "y" }, name: "default", module: "variables" },
      dash([]),
    ];
    const body = file(generatePlan(plan(decls)), "variables.ts");
    expect(body).toContain("const dsPrometheus = new DatasourceVariable(");
    expect(body).toContain("const default2 = new TextboxVariable(");
    expect(body).toContain("const variable404Errors = new TextboxVariable(");
    expect(body).toContain("const default3 = new TextboxVariable(");
  });
});

describe("literals", () => {
  test("a nested value is lifted into a const typed by the class's props (COR001)", () => {
    const files = generatePlan(plan([panel(1, { gridPos: { x: 0, y: 0, w: 6, h: 4 }, options: { reduceOptions: { calcs: ["last"] } } }), dash(["panel:1"])]));
    const panels = file(files, "panels.ts");
    expect(panels).toContain('import { type PropsOf, StatPanel } from "@intentius/chant-lexicon-grafana";');
    expect(panels).toContain('const panel1GridPos: PropsOf<typeof StatPanel>["gridPos"] = { x: 0, y: 0, w: 6, h: 4 };');
    expect(panels).toContain('const panel1Options: PropsOf<typeof StatPanel>["options"] = { reduceOptions: { calcs: ["last"] } };');
    expect(panels).toContain("gridPos: panel1GridPos,");
  });

  test("lists of strings and of references stay inline", () => {
    const files = generatePlan(plan([{ ...dash([]), props: { title: "D", tags: ["a", "b"] } }]));
    expect(file(files, "dashboard.ts")).toContain('const d = new Dashboard({ title: "D", tags: ["a", "b"] });');
  });

  test("a value declaration carries its type annotation and imports the type", () => {
    const files = generatePlan(
      plan([
        { id: "ds", kind: "value", value: { type: "prometheus", uid: "prom" }, type: { text: 'DatasourceRef<"prometheus">', imports: ["DatasourceRef"] }, name: "prom", module: "datasources" },
        panel(1, { datasource: declRef("ds") }),
        dash(["panel:1"]),
      ]),
    );
    expect(file(files, "datasources.ts")).toContain('import { type DatasourceRef } from "@intentius/chant-lexicon-grafana";');
    expect(file(files, "datasources.ts")).toContain('const prom: DatasourceRef<"prometheus"> = { type: "prometheus", uid: "prom" };');
    expect(file(files, "panels.ts")).toContain('import { prom } from "./datasources";');
    expect(file(files, "datasources.ts")).toMatch(/export \{ prom \};\n$/);
  });

  test("multi-line strings become template literals with ${ escaped; quotes pick the lighter form", () => {
    const files = generatePlan(plan([panel(1, { description: "line one\nuses ${var} and `ticks`", title: 'say "hi"' }), dash(["panel:1"])]));
    const body = file(files, "panels.ts");
    expect(body).toContain("description: `line one\nuses \\${var} and \\`ticks\\``");
    expect(body).toContain(`title: 'say "hi"'`);
  });
});

describe("modules", () => {
  test(`a group over ${DECLARABLES_PER_FILE} declarables is split, a panel kept with its queries (COR009)`, () => {
    const decls: Declaration[] = [];
    for (let n = 0; n < 7; n++) decls.push(query(n, "A"), query(n, "B"), panel(n, { targets: [declRef(`query:${n}:A`), declRef(`query:${n}:B`)] }));
    decls.push(dash(Array.from({ length: 7 }, (_, n) => `panel:${n}`)));
    const files = generatePlan(plan(decls));
    const panelFiles = files.filter((f) => f.path.startsWith("panels-"));
    expect(panelFiles.map((f) => f.path)).toEqual(["panels-1.ts", "panels-2.ts", "panels-3.ts", "panels-4.ts"]);
    for (const f of panelFiles) {
      expect((f.content.match(/ = new /g) ?? []).length).toBeLessThanOrEqual(DECLARABLES_PER_FILE);
      // Every panel sits with its two queries.
      const panels = [...f.content.matchAll(/const (panel\d+) = new StatPanel/g)].map((m) => m[1]);
      for (const p of panels) expect(f.content).toContain(`const ${p}A = new PromQuery(`);
    }
    expect(panelFiles[0].content).toContain("/** The panels (1 of 4) */");
    expect(file(files, "dashboard.ts")).toContain('import { panel0, panel1 } from "./panels-1";');
  });

  test("a panel with more queries than fit in one file is split across files", () => {
    const decls: Declaration[] = [];
    const refs = "ABCDEFGHIJ".split("");
    for (const r of refs) decls.push(query(0, r));
    decls.push(panel(0, { targets: refs.map((r) => declRef(`query:0:${r}`)) }), dash(["panel:0"]));
    const files = generatePlan(plan(decls)).filter((f) => f.path.startsWith("panels-"));
    expect(files.map((f) => (f.content.match(/ = new /g) ?? []).length)).toEqual([8, 3]);
    expect(files[1].content).toContain('from "./panels-1";');
  });

  test("only what another module imports is exported, besides the plan's exports", () => {
    const files = generatePlan(plan([query(1, "A"), panel(1, { targets: [declRef("query:1:A")] }), dash(["panel:1"])]));
    expect(file(files, "panels.ts")).toMatch(/export \{ panel1 \};\n$/);
    expect(file(files, "dashboard.ts")).toMatch(/export \{ d \};\n$/);
  });

  test("a directory holds the plan's modules, and imports stay relative to it", () => {
    const files = generatePlan(plan([panel(1), dash(["panel:1"])], { directory: "my-board" }));
    expect(files.map((f) => f.path)).toEqual(["my-board/panels.ts", "my-board/dashboard.ts"]);
    expect(file(files, "my-board/dashboard.ts")).toContain('import { panel1 } from "./panels";');
  });

  test("a class the plan declares is written in plugins.ts and imported where it is used", () => {
    const files = generatePlan(
      plan([{ ...panel(1), className: "PiechartPanel", customClass: "panel-class:piechart" }, dash(["panel:1"])], {
        customClasses: [
          {
            id: "panel-class:piechart",
            className: "PiechartPanel",
            factory: "definePanel",
            definition: { type: "piechart", className: "PiechartPanel", defaultSize: { w: 12, h: 8 } },
            comment: ["// not shipped"],
          },
        ],
      }),
    );
    expect(file(files, "plugins.ts")).toBe(
      [
        "/** Classes for plugins chant has no class for */",
        'import { definePanel } from "@intentius/chant-lexicon-grafana";',
        "",
        "// not shipped",
        "const PiechartPanel = definePanel()({",
        '  type: "piechart",',
        '  className: "PiechartPanel",',
        "  defaultSize: { w: 12, h: 8 },",
        "});",
        "",
        "export { PiechartPanel };",
        "",
      ].join("\n"),
    );
    expect(file(files, "panels.ts")).toContain('import { PiechartPanel } from "./plugins";');
    expect(file(files, "panels.ts")).not.toContain("@intentius/chant-lexicon-grafana");
  });

  test("a reference to something the plan does not declare is an error", () => {
    expect(() => generatePlan(plan([dash(["panel:9"])]))).toThrow(/refers to "panel:9"/);
  });
});

test("an IR with no dashboard (a v2 one, reported by the parser) generates nothing", () => {
  expect(new GrafanaGenerator().generate({ resources: [], parameters: [] })).toEqual([]);
});

test("the generator owns its layout, so core writes its files as they are (#2964)", () => {
  expect(new GrafanaGenerator().ownsLayout).toBe(true);
});

describe("call values (#2954)", () => {
  test("a call is written with the package function imported, its last argument laid out like any value", () => {
    const long = { excludeByName: Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`field number ${i}`, true])) };
    const transformations = [{ id: "merge", options: {} }, callValue("customTransformation", ["sortBy", { fields: {} }]), callValue("customTransformation", ["organize", long])];
    const files = generatePlan(plan([panel(1, { transformations }), dash(["panel:1"])]));
    const text = files.map((f) => f.content).join("\n");
    expect(text).toMatch(/import \{[^}]*customTransformation[^}]*\} from "@intentius\/chant-lexicon-grafana";/);
    expect(text).toContain('  customTransformation("sortBy", { fields: {} }),');
    expect(text).toContain('  customTransformation("organize", {\n    excludeByName: {\n      "field number 0": true,');
  });
});

describe("property-kind declarables, written inline (#2988)", () => {
  // A plan as the parser makes one for a dashboard: panels, rows, queries and variables property-kind, everything merged into the dashboard's module.
  const prop = (d: Declaration): Declaration => ({ ...d, property: true });
  const dashboardPlan = (declarations: Declaration[], modules?: Plan["modules"]): Plan =>
    plan(declarations, {
      main: "dashboard",
      modules: modules ?? [...new Set(declarations.map((d) => d.module))].map((key) => ({ key, file: key, summary: `The ${key}` })),
    });
  const variable = (name: string, extra: Partial<Declaration> = {}): Declaration => ({
    id: `variable:${name}`,
    kind: "new",
    className: "TextboxVariable",
    props: { name },
    name,
    module: "variables",
    property: true,
    ...extra,
  });

  test("one module: the dashboard holds its panels and their queries inline, nested values and all", () => {
    const files = generatePlan(
      dashboardPlan([
        prop(query(1, "A")),
        prop(panel(1, { gridPos: { x: 0, y: 0, w: 6, h: 4 }, options: { reduceOptions: { calcs: ["last"] } }, targets: [declRef("query:1:A")] })),
        dash(["panel:1"]),
      ]),
    );
    expect(files.map((f) => f.path)).toEqual(["dashboard.ts"]);
    expect(files[0].content).toBe(
      [
        "/** The dashboard */",
        'import { Dashboard, PromQuery, StatPanel } from "@intentius/chant-lexicon-grafana";',
        "",
        "const d = new Dashboard({",
        '  title: "D",',
        "  panels: [",
        "    new StatPanel({",
        '      title: "Panel 1",',
        "      gridPos: { x: 0, y: 0, w: 6, h: 4 },",
        '      options: { reduceOptions: { calcs: ["last"] } },',
        '      targets: [new PromQuery({ expr: "up", refId: "A" })],',
        "    }),",
        "  ],",
        "});",
        "",
        "export { d };",
        "",
      ].join("\n"),
    );
  });

  test("a declaration referred to twice, or with a comment, stays a const; a datasource variable is written shorthand", () => {
    const files = generatePlan(
      dashboardPlan([
        variable("env"),
        variable("ds", { className: "DatasourceVariable", props: { name: "ds", pluginType: "prometheus" }, comment: ["// From __inputs"] }),
        prop(panel(1, { datasource: declRef("variable:ds"), repeat: declRef("variable:env") })),
        { ...dash(["panel:1"]), props: { title: "D", variables: [declRef("variable:env"), declRef("variable:ds")], panels: [declRef("panel:1")] } },
      ]),
    );
    const text = file(files, "dashboard.ts");
    expect(text).toContain('const env = new TextboxVariable({ name: "env" });');
    expect(text).toContain('// From __inputs\nconst ds = new DatasourceVariable({ name: "ds", pluginType: "prometheus" });');
    expect(text).toContain("variables: [env, ds],");
    expect(text).toContain('panels: [new StatPanel({ title: "Panel 1", datasource: ds, repeat: env })],');
  });

  test("a value holding a call is lifted into a typed const even on a property-kind declarable (EVL001)", () => {
    const transformations = [callValue("customTransformation", ["sortBy", { fields: {} }])];
    const text = file(generatePlan(dashboardPlan([prop(panel(1, { transformations })), dash(["panel:1"])])), "dashboard.ts");
    expect(text).toContain('const panel1Transformations: PropsOf<typeof StatPanel>["transformations"] = [');
    expect(text).toContain('panels: [new StatPanel({ title: "Panel 1", transformations: panel1Transformations })],');
  });

  test(`past ${LINES_PER_FILE} lines, rows get modules of their own, and what they use moves out of the dashboard's`, () => {
    const long = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`key${i}`, { a: i, b: "a value that keeps the object on lines of its own" }]));
    const decls: Declaration[] = [variable("env"), variable("window")];
    const rows: Plan["modules"][number][] = [];
    for (let r = 0; r < 3; r++) {
      const module = `row:${r}`;
      rows.push({ key: module, file: `row-${r}`, summary: `Row ${r}`, separable: true });
      for (let n = r * 10; n < r * 10 + 10; n++) decls.push(prop(panel(n, { options: long, repeat: declRef("variable:env") }, module)));
      decls.push({ id: `row:${r}`, kind: "new", className: "Row", props: { title: `Row ${r}`, panels: Array.from({ length: 10 }, (_, i) => declRef(`panel:${r * 10 + i}`)) }, name: `Row ${r}`, module, unit: `row:${r}`, property: true });
    }
    decls.push({ ...dash([]), props: { title: "D", variables: [declRef("variable:env"), declRef("variable:window")], panels: [0, 1, 2].map((r) => declRef(`row:${r}`)) } });
    const modules = [{ key: "variables", file: "variables", summary: "The variables" }, ...rows, { key: "dashboard", file: "dashboard", summary: "The dashboard" }];
    const files = generatePlan(dashboardPlan(decls, modules));
    expect(files.map((f) => f.path)).toEqual(["variables.ts", "row-0.ts", "row-1.ts", "row-2.ts", "dashboard.ts"]);
    // env is used by the rows' panels, so it is in variables.ts, which the rows import; window, used only by the dashboard, stays inline there.
    expect(file(files, "variables.ts")).toContain('const env = new TextboxVariable({ name: "env" });');
    expect(file(files, "row-0.ts")).toContain('import { env } from "./variables";');
    expect(file(files, "row-0.ts")).toMatch(/const row0 = new Row\(\{\n  title: "Row 0",\n  panels: \[\n    new StatPanel\(\{/);
    const dashboard = file(files, "dashboard.ts");
    expect(dashboard).toContain('import { row0 } from "./row-0";');
    expect(dashboard).toContain('variables: [env, new TextboxVariable({ name: "window" })],');
    expect(dashboard).not.toMatch(/^export \{[^}]*env/m);
  });

  test(`more than ${DECLARABLES_PER_FILE} resources: the groups holding them get modules of their own; the panels stay inline`, () => {
    const decls: Declaration[] = [];
    for (let n = 0; n < 9; n++) decls.push({ id: `ds:${n}`, kind: "new", className: "ExternalDatasource", props: { type: "prometheus", uid: `p${n}` }, name: `p${n}`, module: "datasources" });
    decls.push(prop(panel(0, { datasource: declRef("ds:0") })), dash(["panel:0"]));
    const files = generatePlan(dashboardPlan(decls));
    expect(files.map((f) => f.path)).toEqual(["datasources-1.ts", "datasources-2.ts", "dashboard.ts"]);
    expect(file(files, "dashboard.ts")).toContain('panels: [new StatPanel({ title: "Panel 0", datasource: p0 })],');
  });
});
