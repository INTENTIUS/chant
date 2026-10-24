import { describe, expect, test } from "vitest";
import { coverageReport, formatCoverage } from "./coverage";
import { otelPlugin } from "./plugin";
import { loadSnapshot } from "./spec/snapshot";

describe("coverageReport against the distribution manifests", () => {
  const report = coverageReport();

  test("every built-in is in otelcol-contrib, and every one with a schema is generated", async () => {
    expect(report.unaccountedKinds).toEqual([]);
    expect(await otelPlugin.coverageReport!()).toMatchObject({ unaccountedKinds: [] });
    expect(report.generated).toHaveLength(34);
    expect(report.handWritten).toEqual(["ForwardConnector"]);
  });

  test("reports each distribution's components and what reaches them", () => {
    const contrib = report.distributions.find((d) => d.distribution === "otelcol-contrib")!;
    expect(contrib.components).toBe(242);
    expect(contrib.withSchema).toBe(213);
    expect(contrib.builtinMissing).toEqual([]);
    expect(contrib.builtin.length + contrib.schemaNotBuiltin.length + contrib.noSchemaNotBuiltin.length).toBe(contrib.components);
    const k8s = report.distributions.find((d) => d.distribution === "otelcol-k8s")!;
    expect(k8s.components).toBe(69);
    // The k8s distribution leaves out the cloud and vendor exporters.
    expect(k8s.builtinMissing).toContain("exporter/googlecloud");
    expect(formatCoverage(report)).toContain("otelcol-contrib v0.162.0: 242 components, 213 with a schema");
  });

  test("a built-in the distribution does not ship is unaccounted", () => {
    const snapshot = loadSnapshot();
    const without = {
      ...snapshot,
      distributions: { ...snapshot.distributions, "otelcol-contrib": snapshot.distributions["otelcol-contrib"].filter((c) => c.type !== "pprof" || c.kind !== "extension") },
    };
    expect(coverageReport(without).unaccountedKinds).toEqual([expect.stringContaining('PprofExtension: extension "pprof" is not in otelcol-contrib')]);
  });
});
