import { describe, expect, it } from "vitest";
import { copyFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { lintCommand } from "@intentius/chant/cli/commands/lint";
import { build } from "@intentius/chant/build";
import { grafanaPlugin } from "../plugin";
import { grafanaSerializer } from "../serializer";
import { BUILTIN_CATALOG } from "../catalog";

// The fixture carries no chant.config of its own, which would make it a
// project in the repo's workspace proposal; the lint test gives it one in a
// temporary directory.
const fixture = join(import.meta.dirname, "..", "..", "test", "fixtures", "inline-dashboard");

describe("core lint on grafana's property-kind declarables (chant #2957)", () => {
  it("names every panel, row, query and variable class property-kind, and no resource", () => {
    const names = grafanaPlugin.propertyClassNames!();
    expect(names).toEqual(expect.arrayContaining(["TimeSeriesPanel", "StatPanel", "Row", "PromQuery", "LokiQuery", "QueryVariable"]));
    for (const resource of ["Dashboard", "Datasource", "DashboardProvider"]) expect(names).not.toContain(resource);
    expect(names).toHaveLength(BUILTIN_CATALOG.filter((e) => e.entityKind === "property").length);
  });

  it("passes COR001, COR004 and COR009 on a dashboard written inline in one file", async () => {
    const project = mkdtempSync(join(tmpdir(), "chant-grafana-lint-"));
    try {
      writeFileSync(join(project, "chant.config.json"), JSON.stringify({ lexicons: ["grafana"] }));
      mkdirSync(join(project, "src"));
      copyFileSync(join(fixture, "dashboard.ts"), join(project, "src", "dashboard.ts"));
      // This test is about the core source rules (COR001/COR004/COR009), not the dashboard's post-synth findings (#3750).
      const result = await lintCommand({ path: join(project, "src"), format: "stylish", postSynth: false });
      expect(result.output).not.toMatch(/COR00[149]|LEX001/);
      expect(result.warningCount).toBe(0);
      expect(result.errorCount).toBe(0);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it("and that file builds", async () => {
    const result = await build(fixture, [grafanaSerializer]);
    expect(result.errors).toEqual([]);
  });
});
