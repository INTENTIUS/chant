import { describe, test, expect } from "bun:test";
import { readdirSync, readFileSync, mkdtempSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { CFParser } from "./parser";
import { CFGenerator } from "./generator";
import { build } from "@intentius/chant/build";
import { awsSerializer } from "../serializer";
import * as awsLexicon from "../index";

const parser = new CFParser();
const generator = new CFGenerator();

const roundtripDir = join(import.meta.dir, "../testdata/roundtrip");
const samDir = join(import.meta.dir, "../testdata/sam-fixtures");

/** Extract imported symbols from `import { A, B } from "..."` statements */
function extractImportedSymbols(code: string): string[] {
  const match = code.match(/import\s*\{([^}]+)\}\s*from\s*/);
  if (!match) return [];
  return match[1].split(",").map((s) => s.trim()).filter(Boolean);
}

const lexiconExports = new Set(Object.keys(awsLexicon));

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

      // Verify main file exists
      const hasMain = files.some((f) => f.path === "main.ts");
      expect(hasMain).toBe(true);

      // Verify resource count: each resource should be represented in generated output
      const resourceNames = Object.keys(template.Resources ?? {});
      const mainFile = files.find((f) => f.path === "main.ts");
      expect(mainFile).toBeDefined();

      for (const name of resourceNames) {
        expect(mainFile!.content).toContain(name);
      }

      // If parameters exist, verify they appear in the output
      const paramNames = Object.keys(template.Parameters ?? {});
      for (const name of paramNames) {
        expect(mainFile!.content).toContain(name);
      }

      // Verify all imported symbols actually exist as exports from the lexicon
      const importedSymbols = extractImportedSymbols(mainFile!.content);
      for (const sym of importedSymbols) {
        expect(lexiconExports.has(sym)).toBe(true);
      }
    });
  }
});

describe("parameters.json build roundtrip", () => {
  test("generated code builds and produces correct CF Parameters", async () => {
    const content = readFileSync(join(roundtripDir, "parameters.json"), "utf-8");
    const source = JSON.parse(content);

    const ir = parser.parse(content);
    const files = generator.generate(ir);
    const mainFile = files.find((f) => f.path === "main.ts")!;

    // Write generated code to a temp directory inside the monorepo (so workspace packages resolve)
    const dir = mkdtempSync(join(import.meta.dir, "../../.roundtrip-tmp-"));
    try {
    const srcDir = join(dir, "src");
    mkdirSync(srcDir);

    // Write generated code as-is (direct imports)
    writeFileSync(join(srcDir, "main.ts"), mainFile.content);

    // Build and verify
    const result = await build(srcDir, [awsSerializer]);
    expect(result.errors).toHaveLength(0);

    const template = JSON.parse(result.outputs.get("aws")!);

    // Verify parameters round-tripped correctly (names preserved as-is)
    for (const [name, param] of Object.entries(source.Parameters ?? {})) {
      const p = param as Record<string, unknown>;
      expect(template.Parameters[name]).toBeDefined();
      expect(template.Parameters[name].Type).toBe(p.Type);
      if (p.Description) {
        expect(template.Parameters[name].Description).toBe(p.Description);
      }
      if (p.Default !== undefined) {
        expect(template.Parameters[name].Default).toBe(p.Default);
      }
    }

    // Verify resources round-tripped (names preserved as-is)
    for (const name of Object.keys(source.Resources ?? {})) {
      expect(template.Resources[name]).toBeDefined();
    }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
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
