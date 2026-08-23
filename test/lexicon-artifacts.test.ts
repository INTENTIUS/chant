import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findMissingLexiconArtifacts, formatMissingArtifacts } from "./lexicon-artifacts";

function lexicon(root: string, name: string, scripts: Record<string, string>, indexTs: string) {
  const lex = join(root, "lexicons", name);
  mkdirSync(join(lex, "src"), { recursive: true });
  writeFileSync(join(lex, "package.json"), JSON.stringify({ scripts }));
  writeFileSync(join(lex, "src", "index.ts"), indexTs);
  return lex;
}

function touch(path: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "");
}

const generated = { generate: "x", bundle: "x" };
const barrelImport = 'export * from "./generated";\n';

describe("findMissingLexiconArtifacts", () => {
  let root: string;
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("reports barrel and bundle outputs for a fresh clone", () => {
    root = mkdtempSync(join(tmpdir(), "chant-1419-"));
    lexicon(root, "aws", generated, barrelImport);
    expect(findMissingLexiconArtifacts(root)).toEqual([
      { lexicon: "aws", missing: ["src/generated/index.ts", "dist/meta.json", "dist/okf/index.md"] },
    ]);
  });

  it("is empty once everything is generated", () => {
    root = mkdtempSync(join(tmpdir(), "chant-1419-"));
    const lex = lexicon(root, "aws", generated, barrelImport);
    touch(join(lex, "src", "generated", "index.ts"));
    touch(join(lex, "dist", "meta.json"));
    touch(join(lex, "dist", "okf", "index.md"));
    expect(findMissingLexiconArtifacts(root)).toEqual([]);
  });

  it("asks for operations.json only when the barrel exists and source reads it", () => {
    root = mkdtempSync(join(tmpdir(), "chant-1419-"));
    const lex = lexicon(root, "k8s", { generate: "x" }, barrelImport);
    touch(join(lex, "src", "generated", "index.ts"));
    mkdirSync(join(lex, "src", "api"), { recursive: true });
    writeFileSync(join(lex, "src", "api", "surface.ts"), 'import ops from "../generated/operations.json";\n');
    expect(findMissingLexiconArtifacts(root)).toEqual([
      { lexicon: "k8s", missing: ["src/generated/operations.json"] },
    ]);
    touch(join(lex, "src", "generated", "operations.json"));
    expect(findMissingLexiconArtifacts(root)).toEqual([]);
  });

  it("ignores lexicons without a generate script", () => {
    root = mkdtempSync(join(tmpdir(), "chant-1419-"));
    lexicon(root, "plain", {}, "");
    expect(findMissingLexiconArtifacts(root)).toEqual([]);
  });

  it("names the lexicons and the commands in the message", () => {
    root = mkdtempSync(join(tmpdir(), "chant-1419-"));
    const text = formatMissingArtifacts([{ lexicon: "k8s", missing: ["dist/meta.json"] }]);
    expect(text).toContain("lexicons/k8s: dist/meta.json");
    expect(text).toContain("just regen");
    expect(text).toContain("npm run generate -w lexicons/k8s && npm run bundle -w lexicons/k8s");
  });
});
