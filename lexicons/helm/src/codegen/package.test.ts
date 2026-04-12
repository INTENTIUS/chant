import { describe, test, expect } from "vitest";
import { packageLexicon } from "./package";

describe("Helm package pipeline", () => {
  test("packageLexicon is importable", async () => {
    const mod = await import("./package");
    expect(typeof mod.packageLexicon).toBe("function");
  });

  test("packageLexicon returns a valid result", async () => {
    const result = await packageLexicon({ verbose: false });
    expect(result).toBeDefined();
    expect(result.spec).toBeDefined();
    expect(result.spec.manifest).toBeDefined();
    expect(result.spec.manifest.name).toBe("helm");
    expect(result.spec.manifest.namespace).toBe("Helm");
    expect(result.spec.manifest.chantVersion).toBeTruthy();
  });

  test("manifest contains intrinsics", async () => {
    const result = await packageLexicon();
    const intrinsics = result.spec.manifest.intrinsics;
    expect(intrinsics).toBeDefined();
    expect(intrinsics!.length).toBeGreaterThan(0);
    const names = intrinsics!.map((i: { name: string }) => i.name);
    expect(names).toContain("values");
    expect(names).toContain("Release");
    expect(names).toContain("include");
  });

  test("stats have resource and property counts", async () => {
    const result = await packageLexicon();
    expect(result.stats.resources).toBeGreaterThan(0);
    expect(result.stats.properties).toBeGreaterThan(0);
  });
});
