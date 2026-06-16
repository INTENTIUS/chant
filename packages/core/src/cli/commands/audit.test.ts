import { describe, test, expect } from "vitest";
import { fileURLToPath } from "url";
import { auditCommand, discoverCiFiles } from "./audit";

const REPO = fileURLToPath(new URL("./__fixtures__/audit-repo", import.meta.url));

describe("auditCommand", () => {
  test("discovers CI files under a repo root", () => {
    const files = discoverCiFiles(REPO);
    expect(files.map((f) => f.path)).toContain(".github/workflows/ci.yml");
    expect(files.every((f) => f.lexicon === "github")).toBe(true);
  });

  test("reports merge-worthy findings on the fixture repo", async () => {
    const result = await auditCommand({ path: REPO, format: "stylish" });
    expect(result.success).toBe(true);
    const ids = new Set(result.findings.map((f) => f.checkId));
    expect(ids).toContain("GHA033");
    expect(ids).toContain("GHA021");
    expect(result.output).toContain("Merge-worthy:");
  });

  test("--json emits parseable findings", async () => {
    const result = await auditCommand({ path: REPO, format: "json" });
    const parsed = JSON.parse(result.output);
    expect(Array.isArray(parsed.findings)).toBe(true);
    expect(parsed.scanned).toContain(".github/workflows/ci.yml");
  });

  test("--fail-on merge-worthy exits nonzero when merge-worthy findings exist", async () => {
    const fail = await auditCommand({ path: REPO, failOn: "merge-worthy" });
    expect(fail.exitCode).toBe(1);
    const none = await auditCommand({ path: REPO, failOn: "none" });
    expect(none.exitCode).toBe(0);
  });

  test("--tier merge-worthy filters out report-only findings", async () => {
    const all = await auditCommand({ path: REPO, tier: "all" });
    const mw = await auditCommand({ path: REPO, tier: "merge-worthy" });
    expect(mw.findings.length).toBeLessThanOrEqual(all.findings.length);
    expect(mw.findings.some((f) => f.checkId === "GHA022")).toBe(false); // report-only
  });

  test("a path with no CI files succeeds with a clear message", async () => {
    const tmp = fileURLToPath(new URL(".", import.meta.url)); // commands dir, no CI files
    const result = await auditCommand({ path: tmp });
    expect(result.success).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("No CI files found");
  });

  test("sarif output is valid JSON with results", async () => {
    const result = await auditCommand({ path: REPO, format: "sarif" });
    const sarif = JSON.parse(result.output);
    expect(sarif.version).toBe("2.1.0");
    expect(sarif.runs[0].results.length).toBeGreaterThan(0);
  });
});
