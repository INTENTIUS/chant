import { describe, test, expect } from "vitest";
import * as ts from "typescript";
import type { LintContext } from "@intentius/chant/lint/rule";
import { templateSizeRule, pinnedImageRule, isFloatingImage } from "./index";

function ctx(code: string): LintContext {
  return { sourceFile: ts.createSourceFile("steward.ts", code, ts.ScriptTarget.Latest, true), entities: [], filePath: "steward.ts" };
}

describe("e2b lint rules", () => {
  describe("E2B001: template size", () => {
    test("flags a fractional or zero cpuCount and an odd or negative memoryMB", () => {
      const diags = templateSizeRule.check(ctx(`new Template({ name: "a", fromImage: "node:22", cpuCount: 1.5, memoryMB: 1023 });`));
      expect(diags.map((d) => d.ruleId)).toEqual(["E2B001", "E2B001"]);
      expect(diags[0].message).toContain("cpuCount 1.5");
      expect(diags[1].message).toContain("memoryMB 1023");
      expect(templateSizeRule.check(ctx(`new Template({ cpuCount: 0, memoryMB: -512 });`))).toHaveLength(2);
    });

    test("passes whole sizes, computed values and other constructors", () => {
      expect(templateSizeRule.check(ctx(`new Template({ cpuCount: 2, memoryMB: 2048 });`))).toHaveLength(0);
      expect(templateSizeRule.check(ctx(`new Template({ cpuCount: n, memoryMB: 1024 * 2 });`))).toHaveLength(0);
      expect(templateSizeRule.check(ctx(`new Machine({ cpuCount: 1.5, memoryMB: 3 });`))).toHaveLength(0);
    });

    test("reports the line of the offending value", () => {
      const [d] = templateSizeRule.check(ctx(`new Template({\n  name: "a",\n  memoryMB: 511,\n});`));
      expect(d.line).toBe(3);
    });
  });

  describe("E2B002: pinned base image", () => {
    test("isFloatingImage spots no tag and latest, and accepts tags and digests", () => {
      for (const floating of ["node", "node:latest", "ghcr.io/acme/base", "registry:5000/acme/base"]) expect(isFloatingImage(floating), floating).toBe(true);
      for (const pinned of ["node:22-bookworm", "registry:5000/acme/base:1.2", "node@sha256:abc"]) expect(isFloatingImage(pinned), pinned).toBe(false);
    });

    test("warns on an unpinned fromImage literal", () => {
      const diags = pinnedImageRule.check(ctx(`new Template({ name: "a", fromImage: "node:latest" });`));
      expect(diags).toHaveLength(1);
      expect(diags[0]).toMatchObject({ ruleId: "E2B002", severity: "warning" });
      expect(pinnedImageRule.check(ctx(`new Template({ name: "a", fromImage: "node:22-bookworm" });`))).toHaveLength(0);
      expect(pinnedImageRule.check(ctx(`new Template({ name: "a", fromImage: base });`))).toHaveLength(0);
    });
  });
});
