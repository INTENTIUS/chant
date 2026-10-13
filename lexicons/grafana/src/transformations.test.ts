import { describe, expect, test } from "vitest";
import { TRANSFORMATION_IDS, customTransformation, transformation, untypedTransformationReason, type Transformation } from "./transformations";
import { TablePanel } from "./panels";
import { Dashboard } from "./dashboard";
import { dashboardJson } from "./build";

describe("transformation types", () => {
  test("cover every transformer Grafana v13.2.2 registers (DataTransformerID less the unregistered append)", () => {
    // packages/grafana-data/src/transformations/transformers/ids.ts at v13.2.2.
    const ids =
      "reduce order organize rename calculateField seriesToColumns seriesToRows merge concatenate labelsToFields filterFields " +
      "filterFieldsByName filterFrames filterByRefId renameByRegex filterByValue noop ensureColumns groupBy sortBy histogram " +
      "configFromData rowsToFields prepareTimeSeries convertFieldType convertFrameType fieldLookup heatmap spatial joinByField " +
      "joinByLabels extractFields groupingToMatrix limit partitionByValues timeSeriesTable transpose formatTime formatString " +
      "regression smoothing groupToNestedTable";
    expect([...TRANSFORMATION_IDS].sort()).toEqual(ids.split(" ").sort());
  });

  test("typed transformations, the helper and the escape hatch serialize as Grafana stores them", () => {
    const transformations: Transformation[] = [
      { id: "organize", options: { excludeByName: { Time: true }, renameByName: { Value: "Requests" } } },
      transformation("reduce", { reducers: ["max", "p95"], mode: "reduceFields" }, { disabled: true }),
      transformation("merge"),
      customTransformation("my-plugin-transformer", { level: 3 }, { topic: "annotations" }),
    ];
    const d = new Dashboard({ title: "T", uid: "t", panels: [new TablePanel({ title: "p", transformations })] });
    const panel = (JSON.parse(dashboardJson(d)) as { panels: Array<{ transformations: unknown }> }).panels[0];
    expect(panel.transformations).toEqual([
      { id: "organize", options: { excludeByName: { Time: true }, renameByName: { Value: "Requests" } } },
      { id: "reduce", options: { reducers: ["max", "p95"], mode: "reduceFields" }, disabled: true },
      { id: "merge", options: {} },
      { id: "my-plugin-transformer", options: { level: 3 }, topic: "annotations" },
    ]);
  });

  test("the types reject an unknown id, an unknown option and a bad enum value", () => {
    const bad: Transformation[] = [
      // @ts-expect-error: not a transformer Grafana registers; customTransformation() takes one
      { id: "my-plugin-transformer", options: {} },
      // @ts-expect-error: organize has excludeByName, not excludeByname
      { id: "organize", options: { excludeByname: {} } },
      // @ts-expect-error: not a ReducerID
      { id: "reduce", options: { reducers: ["maximum"] } },
    ];
    // @ts-expect-error: sortBy takes `sort`, not `fields`; the helper checks against the one transformer
    transformation("sortBy", { fields: {} });
    expect(bad).toHaveLength(3);
  });
});

describe("untypedTransformationReason, which the importer uses", () => {
  test("is undefined for what the types hold", () => {
    expect(untypedTransformationReason({ id: "organize", options: { excludeByName: {}, indexByName: {} }, disabled: false })).toBeUndefined();
    expect(untypedTransformationReason({ id: "merge", options: {} })).toBeUndefined();
    expect(untypedTransformationReason({ id: "timeSeriesTable", options: { A: { stat: "mean" } } })).toBeUndefined();
    expect(untypedTransformationReason({ id: "limit" })).toBeUndefined();
  });

  test("names what they don't", () => {
    expect(untypedTransformationReason({ id: "grafana-plugin-x", options: {} })).toBe('"grafana-plugin-x" is not a transformer Grafana v13.2.2 registers');
    expect(untypedTransformationReason({ id: "sortBy", options: { fields: {}, sort: [] } })).toBe('the sortBy transformer takes no option "fields"');
    expect(untypedTransformationReason({ id: "merge", options: {}, name: "x" })).toBe('it has "name" beside its id and options');
    expect(untypedTransformationReason({ id: "reduce", options: [] })).toBe("its options are not an object");
  });
});
