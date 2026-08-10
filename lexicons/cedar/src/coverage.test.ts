import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { computeCedarCoverage, formatCedarCoverage } from "./coverage";

const pkgDir = dirname(dirname(fileURLToPath(import.meta.url)));

function generatedDirWith(registry: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "cedar-coverage-"));
  writeFileSync(join(dir, "lexicon-cedar.json"), JSON.stringify(registry));
  return dir;
}

describe("cedar coverage", () => {
  it("reports full coverage for artifacts generated from the same schema", () => {
    const report = computeCedarCoverage({ projectRoot: join(pkgDir, "nowhere") });
    expect(report.isDefaultSchema).toBe(true);
    expect(report.entityTypes).toBe(7);
    expect(report.actions).toBe(9);
    expect(report.overallPct).toBe(100);
  });

  it("names the declarations the artifacts do not reach", () => {
    // The failure this exists to catch: a schema action with no generated
    // constant is an action a policy can only name as a hand-typed string.
    const generatedDir = generatedDirWith({
      User: { resourceType: "App::User", kind: "resource" },
      UserAttributes: { resourceType: "App::User.Attributes", kind: "property" },
    });

    const report = computeCedarCoverage({ projectRoot: join(pkgDir, "nowhere"), generatedDir });
    expect(report.entityTypesCovered).toBe(1);
    expect(report.actionsCovered).toBe(0);
    expect(report.actionPct).toBe(0);
    expect(report.overallPct).toBeLessThan(100);

    const gap = report.items.find((i) => i.name === 'App::Action::"read"');
    expect(gap?.covered).toBe(false);
    expect(formatCedarCoverage(report, true)).toContain("no generated declaration");
  });

  it("reports against a project schema when one is configured", () => {
    const example = join(pkgDir, "examples", "basic-policies");
    const report = computeCedarCoverage({ projectRoot: example, config: { schema: "schema.cedarschema" } });
    expect(report.isDefaultSchema).toBe(false);
    // The example's schema is a subset of the default one, so artifacts
    // generated from either cover it.
    expect(report.overallPct).toBe(100);
  });

  it("treats a schema with nothing in it as covered rather than dividing by zero", () => {
    const generatedDir = generatedDirWith({});
    const empty = mkdtempSync(join(tmpdir(), "cedar-empty-"));
    writeFileSync(join(empty, "schema.cedarschema"), "");
    const report = computeCedarCoverage({ projectRoot: empty, generatedDir });
    expect(report.overallPct).toBe(100);
    expect(report.entityTypes).toBe(0);
  });
});
