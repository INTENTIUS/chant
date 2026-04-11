import { describe, test, expect } from "vitest";
import { existsSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const pkgDir = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const generatedDir = join(pkgDir, "src", "generated");
const hasGenerated = existsSync(join(generatedDir, "lexicon-flyway.json"));

describe("snapshot", () => {
  test.skipIf(!hasGenerated)("lexicon-flyway.json is valid JSON", () => {
    const raw = readFileSync(join(generatedDir, "lexicon-flyway.json"), "utf-8");
    const parsed = JSON.parse(raw);
    expect(typeof parsed).toBe("object");
    expect(parsed).not.toBeNull();
  });

  test.skipIf(!hasGenerated)("lexicon entries have required fields", () => {
    const raw = readFileSync(join(generatedDir, "lexicon-flyway.json"), "utf-8");
    const registry = JSON.parse(raw) as Record<string, any>;

    for (const [name, entry] of Object.entries(registry)) {
      expect(entry.resourceType).toBeDefined();
      expect(entry.kind).toBeDefined();
      expect(["resource", "property"]).toContain(entry.kind);
    }
  });

  test.skipIf(!hasGenerated)("contains FlywayProject entry", () => {
    const raw = readFileSync(join(generatedDir, "lexicon-flyway.json"), "utf-8");
    const registry = JSON.parse(raw) as Record<string, any>;

    const project = Object.values(registry).find(
      (e: any) => e.resourceType === "Flyway::Project",
    );
    expect(project).toBeDefined();
    expect(project!.kind).toBe("resource");
  });

  test.skipIf(!hasGenerated)("contains Environment entry", () => {
    const raw = readFileSync(join(generatedDir, "lexicon-flyway.json"), "utf-8");
    const registry = JSON.parse(raw) as Record<string, any>;

    const env = Object.values(registry).find(
      (e: any) => e.resourceType === "Flyway::Environment",
    );
    expect(env).toBeDefined();
    expect(env!.kind).toBe("resource");
  });

  test.skipIf(!hasGenerated)("contains FlywayConfig entry", () => {
    const raw = readFileSync(join(generatedDir, "lexicon-flyway.json"), "utf-8");
    const registry = JSON.parse(raw) as Record<string, any>;

    const config = Object.values(registry).find(
      (e: any) => e.resourceType === "Flyway::Config",
    );
    expect(config).toBeDefined();
  });

  test.skipIf(!hasGenerated)("contains VaultResolver entry", () => {
    const raw = readFileSync(join(generatedDir, "lexicon-flyway.json"), "utf-8");
    const registry = JSON.parse(raw) as Record<string, any>;

    const vault = Object.values(registry).find(
      (e: any) => e.resourceType === "Flyway::Resolver.Vault",
    );
    expect(vault).toBeDefined();
  });

  test.skipIf(!hasGenerated)("index.d.ts contains type declarations", () => {
    const dtsPath = join(generatedDir, "index.d.ts");
    if (!existsSync(dtsPath)) return;

    const dts = readFileSync(dtsPath, "utf-8");
    expect(dts).toContain("FlywayProject");
    expect(dts).toContain("Environment");
    expect(dts).toContain("FlywayConfig");
  });
});
