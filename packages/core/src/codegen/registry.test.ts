import { describe, test, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadLexiconRegistry, LexiconRegistryMissingError } from "./registry";

const REGISTRY = { Bucket: { resourceType: "AWS::S3::Bucket", kind: "resource" } };

function pkg(): string {
  return mkdtempSync(join(tmpdir(), "chant-registry-"));
}

describe("loadLexiconRegistry (#1367)", () => {
  test("reads the dev copy — src/generated, which is what a working checkout has", () => {
    const dir = pkg();
    mkdirSync(join(dir, "src", "generated"), { recursive: true });
    writeFileSync(join(dir, "src", "generated", "lexicon-aws.json"), JSON.stringify(REGISTRY));
    expect(loadLexiconRegistry(dir, "aws")).toEqual(REGISTRY);
  });

  test("falls back to dist/meta.json — what an installed package ships", () => {
    const dir = pkg();
    mkdirSync(join(dir, "dist"), { recursive: true });
    writeFileSync(join(dir, "dist", "meta.json"), JSON.stringify(REGISTRY));
    expect(loadLexiconRegistry(dir, "aws")).toEqual(REGISTRY);
  });

  test("prefers the dev copy when both exist", () => {
    const dir = pkg();
    mkdirSync(join(dir, "src", "generated"), { recursive: true });
    mkdirSync(join(dir, "dist"), { recursive: true });
    writeFileSync(join(dir, "src", "generated", "lexicon-aws.json"), JSON.stringify({ Dev: REGISTRY.Bucket }));
    writeFileSync(join(dir, "dist", "meta.json"), JSON.stringify({ Dist: REGISTRY.Bucket }));
    expect(Object.keys(loadLexiconRegistry(dir, "aws"))).toEqual(["Dev"]);
  });

  test("throws with the command to run, rather than a module-not-found or an empty map", () => {
    // The whole point. An empty map reads downstream as a lexicon with no
    // resource types, which is how azure's import came to emit
    // `// Unknown resource type: Microsoft.…` and look like a coverage gap.
    const dir = pkg();
    expect(() => loadLexiconRegistry(dir, "azure")).toThrow(LexiconRegistryMissingError);
    expect(() => loadLexiconRegistry(dir, "azure")).toThrow(/npm run --prefix lexicons\/azure prepack/);
  });

  test("names the lexicon that is missing, not a generic one", () => {
    const dir = pkg();
    try {
      loadLexiconRegistry(dir, "gcp");
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as LexiconRegistryMissingError).lexicon).toBe("gcp");
      expect((err as Error).message).toContain("lexicons/gcp");
    }
  });
});
