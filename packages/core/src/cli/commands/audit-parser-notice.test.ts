import { describe, test, expect, vi, beforeAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// The optional HCL parser is absent. Every load of it fails the way an
// uninstalled package does, so `loadHcl2json` raises `Hcl2JsonNotInstalled`
// once per audited input, not only on the first.
vi.mock("../../terraform/hcl2json", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../terraform/hcl2json")>();
  return {
    ...real,
    loadHcl2json: async () => {
      throw new real.Hcl2JsonNotInstalled(new Error("Cannot find package '@cdktn/hcl2json'"));
    },
  };
});

import { auditCommand, printAuditResult } from "./audit";
import { loadAuditPlugins } from "../../audit/discover";

beforeAll(async () => {
  await loadAuditPlugins();
}, 60_000);

function repoWithTerraform(): string {
  const root = mkdtempSync(join(tmpdir(), "chant-audit-parser-"));
  for (const dir of ["envs/prod", "envs/dev"]) {
    mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, dir, "main.tf"), `resource "aws_s3_bucket" "b" {\n  bucket = "${dir.replace("/", "-")}"\n}\n`);
  }
  return root;
}

describe("chant audit with the HCL parser not installed (#5083)", () => {
  test("the JSON report lists the skipped directories and the package", async () => {
    const root = repoWithTerraform();
    try {
      const result = await auditCommand({ path: root, format: "json" });
      expect(result.success).toBe(true);
      const report = JSON.parse(result.output);
      expect(report.skipped).toHaveLength(1);
      expect(report.skipped[0]).toMatchObject({
        lexicon: "terraform",
        reason: "parser-not-installed",
        package: "@cdktn/hcl2json",
        install: "npm install -D @cdktn/hcl2json",
      });
      expect(report.skipped[0].paths.sort()).toEqual(["envs/dev", "envs/prod"]);
      expect(result.skipped).toEqual(report.skipped);
      expect(result.warnings?.[0]?.message).toContain("npm install -D @cdktn/hcl2json");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the text report and the log both say so", async () => {
    const root = repoWithTerraform();
    const errors: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((m) => void errors.push(String(m)));
    try {
      const result = await auditCommand({ path: root });
      expect(result.output).toContain("not installed");
      expect(result.output).toContain("npm install -D @cdktn/hcl2json");
      const out = join(root, "report.txt");
      const written = await auditCommand({ path: root, format: "markdown", output: out });
      printAuditResult(written);
      expect(errors.join("\n")).toContain("npm install -D @cdktn/hcl2json");
    } finally {
      spy.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
