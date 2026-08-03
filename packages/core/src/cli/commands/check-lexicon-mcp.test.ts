import { describe, test, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { mcpNameViolations, lexiconNameFor } from "./check-lexicon-mcp";

const tools = (...names: string[]) => names.map((name) => ({ name }));
const resources = (...uris: string[]) => uris.map((uri) => ({ uri }));

describe("mcpNameViolations (#1341)", () => {
  test("a bare tool name is fine — core supplies the namespace", () => {
    expect(mcpNameViolations("gitlab", tools("migrate"), [])).toEqual([]);
  });

  test("a self-prefixed tool name is fine — core does not double it", () => {
    expect(mcpNameViolations("gitlab", tools("gitlab:diff"), [])).toEqual([]);
  });

  test("a name carrying another lexicon's prefix is a violation", () => {
    // This is the shape the doubling bug produced: `gitlab:gitlab:diff`.
    const found = mcpNameViolations("git", tools("gitlab:diff"), []);
    expect(found).toHaveLength(1);
    expect(found[0]).toContain("git:gitlab:diff");
  });

  test("an uppercase or spaced tool name is a violation", () => {
    expect(mcpNameViolations("aws", tools("Diff Resources"), [])).toHaveLength(1);
    expect(mcpNameViolations("aws", tools("Diff"), [])).toHaveLength(1);
  });

  test("hyphenated verbs are allowed", () => {
    expect(mcpNameViolations("github", tools("github:workflow-yaml"), [])).toEqual([]);
  });

  test("a bare resource path is fine", () => {
    expect(mcpNameViolations("aws", [], resources("examples/s3-bucket"))).toEqual([]);
  });

  test("the colon form the shared catalog helper emits is fine", () => {
    expect(mcpNameViolations("aws", [], resources("aws:resource-catalog"))).toEqual([]);
  });

  test("the chant://lexicon/<name>/ form the authoring docs taught is fine once normalized", () => {
    expect(mcpNameViolations("azure", [], resources("chant://lexicon/azure/catalog"))).toEqual([]);
  });

  test("a uri carrying a foreign scheme is a violation", () => {
    // azure shipped `chant://azure/chant://lexicon/azure/catalog` this way when
    // the lexicon name in the uri did not match the lexicon being registered.
    const found = mcpNameViolations("aws", [], resources("chant://lexicon/azure/catalog"));
    expect(found).toHaveLength(1);
    expect(found[0]).toContain("chant://aws/chant://lexicon/azure/catalog");
  });

  test("an already-registered uri passes through", () => {
    expect(mcpNameViolations("aws", [], resources("chant://aws/catalog"))).toEqual([]);
  });

  test("tools and resources are reported together", () => {
    expect(mcpNameViolations("aws", tools("Bad Name"), resources("chant://other/x"))).toHaveLength(2);
  });

  test("a lexicon contributing nothing has nothing to violate", () => {
    expect(mcpNameViolations("fly", [], [])).toEqual([]);
  });
});

describe("lexiconNameFor", () => {
  function fixture(pkg?: Record<string, unknown>): string {
    const dir = mkdtempSync(join(tmpdir(), "chant-mcp-name-"));
    mkdirSync(dir, { recursive: true });
    if (pkg) writeFileSync(join(dir, "package.json"), JSON.stringify(pkg));
    return dir;
  }

  test("reads the lexicon name out of the package name", () => {
    expect(lexiconNameFor(fixture({ name: "@intentius/chant-lexicon-aws" }))).toBe("aws");
  });

  test("handles a hyphenated lexicon name", () => {
    expect(lexiconNameFor(fixture({ name: "@intentius/chant-lexicon-my-cloud" }))).toBe("my-cloud");
  });

  test("falls back to the directory name when package.json is missing", () => {
    const dir = fixture();
    expect(lexiconNameFor(dir)).toBe(dir.split("/").pop());
  });

  test("falls back when the package name is not a lexicon package", () => {
    const dir = fixture({ name: "@intentius/chant" });
    expect(lexiconNameFor(dir)).toBe(dir.split("/").pop());
  });
});
