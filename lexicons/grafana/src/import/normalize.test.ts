import { describe, expect, test } from "vitest";
import { canonicalVariableUid, isBuiltinAnnotation, normalizeDashboard, refIdAt, splitValues } from "./normalize";
import { applyEdits, pointer, pointerSegments } from "./edits";

const prom = { type: "prometheus", uid: "prom" };

describe("normalizeDashboard", () => {
  test("keys at Grafana's default and the stored copy's bookkeeping are the same as no key", () => {
    const stored = {
      id: 12,
      version: 4,
      title: "T",
      uid: "t",
      editable: true,
      graphTooltip: 0,
      links: [],
      tags: [],
      time: { from: "now-6h", to: "now" },
      timepicker: {},
      timezone: "",
      weekStart: "",
      refresh: false,
      annotations: { list: [] },
      templating: { list: [] },
      panels: [],
    };
    expect(normalizeDashboard(stored)).toEqual({ title: "T", uid: "t", panels: [] });
  });

  test("the built-in annotation, in any of the forms Grafana has written it, is no annotation", () => {
    const base = { builtIn: 1, enable: true, hide: true, iconColor: "rgba(0, 211, 255, 1)", name: "Annotations & Alerts", type: "dashboard" };
    for (const datasource of ["-- Grafana --", { type: "grafana", uid: "-- Grafana --" }, { type: "datasource", uid: "grafana" }, { uid: "-- Grafana --" }]) {
      expect(isBuiltinAnnotation({ ...base, datasource })).toBe(true);
    }
    expect(isBuiltinAnnotation({ ...base, datasource: "-- Grafana --", target: { limit: 100, matchAny: false, tags: [], type: "dashboard" } })).toBe(true);
    expect(isBuiltinAnnotation({ ...base, datasource: "-- Grafana --", enable: false })).toBe(false);
    expect(isBuiltinAnnotation({ ...base, datasource: prom })).toBe(false);
  });

  test("a query without a datasource or refId gets its panel's and its position's", () => {
    const d = normalizeDashboard({ panels: [{ type: "stat", datasource: { type: "prometheus", uid: "$ds" }, targets: [{ expr: "up" }, { expr: "down", refId: "" }] }] });
    const ds = { type: "prometheus", uid: "${ds}" };
    expect(d.panels).toEqual([
      { type: "stat", datasource: ds, fieldConfig: { defaults: {}, overrides: [] }, targets: [{ expr: "up", datasource: ds, refId: "A" }, { expr: "down", datasource: ds, refId: "B" }] },
    ]);
  });

  test("a panel's datasource is the one its queries share, whatever the panel says", () => {
    const mixed = { type: "datasource", uid: "-- Mixed --" };
    const [p] = normalizeDashboard({ panels: [{ type: "stat", datasource: mixed, targets: [{ refId: "A", datasource: prom }] }] }).panels as Array<{ datasource: unknown }>;
    expect(p.datasource).toEqual(prom);
  });

  test("derived variable keys: options, a query variable's definition, a constant's current", () => {
    const d = normalizeDashboard({
      templating: {
        list: [
          { type: "query", name: "a", query: "q", definition: "q", refresh: 1, options: [{ text: "x", value: "x" }], current: {} },
          { type: "query", name: "b", query: "q", refresh: 0, options: [{ text: "x", value: "x" }] },
          { type: "custom", name: "c", query: "x, y", options: [] },
          { type: "constant", name: "k", query: "v", hide: 2, current: { text: "v", value: "v" } },
          { type: "textbox", name: "t", query: "v", current: { text: "v", value: "v", selected: false } },
        ],
      },
    });
    expect(d.templating).toEqual({
      list: [
        { type: "query", name: "a", query: "q" },
        { type: "query", name: "b", query: "q", refresh: 0, options: [{ text: "x", value: "x" }] },
        { type: "custom", name: "c", query: "x,y", current: { text: "x", value: "x" } },
        { type: "constant", name: "k", query: "v" },
        { type: "textbox", name: "t", query: "v" },
      ],
    });
  });

  test("nothing inside options is touched: a null there means something", () => {
    const steps = [{ color: "green", value: null }];
    const d = normalizeDashboard({ panels: [{ type: "stat", fieldConfig: { defaults: { thresholds: { steps } } } }] });
    expect((d.panels as Array<{ fieldConfig: { defaults: unknown } }>)[0].fieldConfig.defaults).toEqual({ thresholds: { steps } });
  });
});

describe("helpers", () => {
  test("refIdAt", () => {
    expect([0, 1, 25, 26, 27].map(refIdAt)).toEqual(["A", "B", "Z", "AA", "AB"]);
  });

  test("canonicalVariableUid", () => {
    expect(["$ds", "${ds}", "[[ds]]", "${ds:raw}", "prom"].map(canonicalVariableUid)).toEqual(["${ds}", "${ds}", "${ds}", "${ds:raw}", "prom"]);
  });

  test("splitValues: commas, escaped commas and spaces", () => {
    expect(splitValues("a, b\\,c ,, d")).toEqual(["a", "b,c", "d"]);
  });
});

describe("applyEdits", () => {
  test("substitutions, then replacements and removals by pointers into the original, then prepended variables", () => {
    const source = { title: "${VAR}", panels: [{ id: 1 }, { id: 2, "a/b": 1 }, { id: 3 }], templating: { list: [{ name: "x" }] } };
    const out = applyEdits(source, [
      { op: "substitute", from: "${VAR}", to: "v" },
      { op: "remove", path: "/panels/0" },
      { op: "replace", path: pointer("panels", 1, "a/b"), value: 2 },
      { op: "remove", path: "/panels/2" },
      { op: "prependVariable", value: { name: "DS" } },
    ]);
    expect(out).toEqual({ title: "v", panels: [{ id: 2, "a/b": 2 }], templating: { list: [{ name: "DS" }, { name: "x" }] } });
    // The source is left as it was.
    expect(source.panels).toHaveLength(3);
  });

  test("pointers escape / and ~", () => {
    expect(pointer("a/b", "c~d", 0)).toBe("/a~1b/c~0d/0");
    expect(pointerSegments("/a~1b/c~0d/0")).toEqual(["a/b", "c~d", "0"]);
  });
});
