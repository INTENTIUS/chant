import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { computeFountainCoverage, formatVerbose, EXCLUDED_KINDS } from "./coverage";

const srcDir = dirname(fileURLToPath(import.meta.url));
const spec = readFileSync(join(srcDir, "spec", "fountain-openapi.snapshot.json"), "utf-8");
const surface = JSON.parse(
  readFileSync(join(srcDir, "..", "surface.snapshot.json"), "utf-8"),
) as { entries: Record<string, { kind: string; props?: string[] }> };

describe("fountain coverage", () => {
  it("reports the committed surface as fully covering the spec", () => {
    const report = computeFountainCoverage(spec, surface);

    expect(report.overallPct).toBe(100);
    expect(report.modeledKinds.sort()).toEqual(["Agent", "Environment", "Vault"]);
    for (const kind of report.kinds) {
      expect(kind.missing).toEqual([]);
      expect(kind.stale).toEqual([]);
    }
  });

  it("accounts for every request schema in the spec", () => {
    // The guard that matters: a new upstream kind must be modeled or
    // explicitly excluded, never silently absent.
    const report = computeFountainCoverage(spec, surface);
    expect(report.unaccountedKinds).toEqual([]);
  });

  it("flags a property upstream added that the surface lacks", () => {
    const stripped = structuredClone(surface);
    stripped.entries.Agent.props = stripped.entries.Agent.props!.filter(
      (p) => !p.startsWith("system:"),
    );

    const report = computeFountainCoverage(spec, stripped);
    const agent = report.kinds.find((k) => k.kind === "Agent")!;

    expect(agent.missing).toEqual(["system"]);
    expect(report.overallPct).toBeLessThan(100);
  });

  it("flags a surface property upstream no longer has", () => {
    const extra = structuredClone(surface);
    extra.entries.Vault.props = [...extra.entries.Vault.props!, "retired_field:false"];

    const report = computeFountainCoverage(spec, extra);
    const vault = report.kinds.find((k) => k.kind === "Vault")!;

    expect(vault.stale).toEqual(["retired_field"]);
  });

  it("names the reason for each unmodeled kind in verbose output", () => {
    const text = formatVerbose(computeFountainCoverage(spec, surface));

    for (const [name, reason] of Object.entries(EXCLUDED_KINDS)) {
      expect(text).toContain(name);
      expect(text).toContain(reason);
    }
  });
});
