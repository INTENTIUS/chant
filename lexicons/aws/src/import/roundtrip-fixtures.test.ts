import { describe, test, expect } from "bun:test";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { CFParser } from "./parser";
import { CFGenerator } from "./generator";

const parser = new CFParser();
const generator = new CFGenerator();

const roundtripDir = join(import.meta.dir, "../testdata/roundtrip");
const samDir = join(import.meta.dir, "../testdata/sam-fixtures");

describe("CF roundtrip fixtures", () => {
  const fixtures = readdirSync(roundtripDir).filter((f) => f.endsWith(".json"));

  for (const fixture of fixtures) {
    test(`roundtrip: ${fixture}`, () => {
      const content = readFileSync(join(roundtripDir, fixture), "utf-8");
      const template = JSON.parse(content);

      const ir = parser.parse(content);
      const files = generator.generate(ir);

      // Verify at least one file was generated
      expect(files.length).toBeGreaterThanOrEqual(1);

      // Verify barrel/main file exists
      const hasBarrel = files.some(
        (f) => f.path === "main.ts" || f.path === "_.ts",
      );
      expect(hasBarrel).toBe(true);

      // Verify resource count: each resource should be represented in generated output
      const resourceNames = Object.keys(template.Resources ?? {});
      const mainFile = files.find((f) => f.path === "main.ts" || f.path === "_.ts");
      expect(mainFile).toBeDefined();

      for (const name of resourceNames) {
        const varName = name.charAt(0).toLowerCase() + name.slice(1);
        expect(mainFile!.content).toContain(varName);
      }

      // If parameters exist, verify they appear in the output
      const paramNames = Object.keys(template.Parameters ?? {});
      for (const name of paramNames) {
        const varName = name.charAt(0).toLowerCase() + name.slice(1);
        expect(mainFile!.content).toContain(varName);
      }
    });
  }
});

describe("SAM roundtrip fixtures", () => {
  const fixtures = readdirSync(samDir).filter(
    (f) => f.endsWith(".yaml") || f.endsWith(".yml"),
  );

  for (const fixture of fixtures) {
    test(`SAM roundtrip: ${fixture}`, () => {
      const content = readFileSync(join(samDir, fixture), "utf-8");

      // Parse should not throw (YAML support)
      const ir = parser.parse(content);

      // Generate should produce output
      const files = generator.generate(ir);

      // Verify at least one .ts file was generated
      expect(files.length).toBeGreaterThanOrEqual(1);
      expect(files.some((f) => f.path.endsWith(".ts"))).toBe(true);

      // Verify no empty content
      for (const file of files) {
        expect(file.content.length).toBeGreaterThan(0);
      }
    });
  }
});
