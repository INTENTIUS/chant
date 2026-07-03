import { describe, test, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { bumpForSeverity, bumpPackageJsonVersion } from "./version-bump";

describe("bumpForSeverity", () => {
  test("pre-1.0: additive bumps the patch, breaking bumps the minor (never auto-1.0.0)", () => {
    expect(bumpForSeverity("0.13.1", "additive")).toBe("0.13.2");
    expect(bumpForSeverity("0.13.1", "breaking")).toBe("0.14.0");
    expect(bumpForSeverity("0.0.9", "breaking")).toBe("0.1.0");
  });

  test(">= 1.0.0: additive bumps the minor, breaking bumps the major", () => {
    expect(bumpForSeverity("1.2.3", "additive")).toBe("1.3.0");
    expect(bumpForSeverity("1.2.3", "breaking")).toBe("2.0.0");
  });

  test("tolerates a leading v", () => {
    expect(bumpForSeverity("v0.14.0", "additive")).toBe("0.14.1");
  });

  test("returns null for none or an unparseable version", () => {
    expect(bumpForSeverity("0.13.1", "none")).toBeNull();
    expect(bumpForSeverity("1.2", "additive")).toBeNull();
    expect(bumpForSeverity("not-a-version", "breaking")).toBeNull();
  });
});

describe("bumpPackageJsonVersion", () => {
  test("rewrites only the version, preserving other fields + trailing newline", () => {
    const dir = mkdtempSync(join(tmpdir(), "vbump-"));
    try {
      const pkgPath = join(dir, "package.json");
      writeFileSync(pkgPath, JSON.stringify({ name: "x", version: "0.13.1", scripts: { build: "tsc" } }, null, 2));
      bumpPackageJsonVersion(pkgPath, "0.14.0");
      const raw = readFileSync(pkgPath, "utf-8");
      const pkg = JSON.parse(raw) as { name: string; version: string; scripts: Record<string, string> };
      expect(pkg.version).toBe("0.14.0");
      expect(pkg.name).toBe("x");
      expect(pkg.scripts.build).toBe("tsc");
      expect(raw.endsWith("\n")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
