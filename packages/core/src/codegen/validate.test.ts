import { describe, test, expect } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { validateLexiconArtifacts } from "./validate";

function makeTempDir(): string {
  const dir = join(tmpdir(), `chant-validate-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("validateLexiconArtifacts", () => {
  test("fails when lexicon JSON is missing", async () => {
    const dir = makeTempDir();
    const genDir = join(dir, "src", "generated");
    mkdirSync(genDir, { recursive: true });

    const result = await validateLexiconArtifacts({
      lexiconJsonFilename: "lexicon-test.json",
      requiredNames: ["Resource"],
      basePath: dir,
    });

    expect(result.success).toBe(false);
    const jsonCheck = result.checks.find((c) => c.name === "lexicon-json-exists");
    expect(jsonCheck?.ok).toBe(false);
    expect(jsonCheck?.error).toContain("lexicon-test.json not found");

    rmSync(dir, { recursive: true, force: true });
  });

  test("passes with valid artifacts and required names", async () => {
    const dir = makeTempDir();
    const genDir = join(dir, "src", "generated");
    mkdirSync(genDir, { recursive: true });

    const lexiconData = {
      Resource: {
        resourceType: "Test::Storage::Bucket",
        kind: "resource",
        lexicon: "test",
        attrs: { arn: "Arn" },
        createOnly: ["/properties/Name"],
        propertyConstraints: { Name: { minLength: 1 } },
        constraints: [{ name: "c1", type: "required_or" }],
      },
    };
    writeFileSync(join(genDir, "lexicon-test.json"), JSON.stringify(lexiconData));
    writeFileSync(join(genDir, "index.d.ts"), "export declare class Resource { readonly type: string; }");

    const result = await validateLexiconArtifacts({
      lexiconJsonFilename: "lexicon-test.json",
      requiredNames: ["Resource"],
      basePath: dir,
      coverageThresholds: { minPropertyPct: 1 },
    });

    expect(result.success).toBe(true);
    expect(result.checks.every((c) => c.ok)).toBe(true);

    rmSync(dir, { recursive: true, force: true });
  });

  test("detects missing required names", async () => {
    const dir = makeTempDir();
    const genDir = join(dir, "src", "generated");
    mkdirSync(genDir, { recursive: true });

    writeFileSync(join(genDir, "lexicon-test.json"), JSON.stringify({ Foo: { resourceType: "T", kind: "resource", lexicon: "t" } }));
    writeFileSync(join(genDir, "index.d.ts"), "export {};");

    const result = await validateLexiconArtifacts({
      lexiconJsonFilename: "lexicon-test.json",
      requiredNames: ["Bar", "Baz"],
      basePath: dir,
    });

    const namesCheck = result.checks.find((c) => c.name === "required-names");
    expect(namesCheck?.ok).toBe(false);
    expect(namesCheck?.error).toContain("Bar");
    expect(namesCheck?.error).toContain("Baz");

    rmSync(dir, { recursive: true, force: true });
  });
});
