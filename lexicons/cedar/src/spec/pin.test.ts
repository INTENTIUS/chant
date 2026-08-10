import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertPinnedLangVersion,
  assertPinnedSchema,
  CEDAR_LANG_VERSION,
  CEDAR_SCHEMA_PIN,
  CEDAR_WASM_VERSION,
  PINNED_SCHEMA_NAMES,
  resolvedSchemaDigest,
  schemaDrift,
} from "./pin";
import { langVersion, packageVersion } from "./wasm";
import { defaultSchemaPath } from "./fetch";
import { parseCedarSchema } from "./parse";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

describe("version pin", () => {
  it("matches the installed cedar-wasm", () => {
    expect(packageVersion()).toBe(CEDAR_WASM_VERSION);
    expect(langVersion()).toBe(CEDAR_LANG_VERSION);
  });

  it("matches the version in package.json, which is what npm installs", () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, "lexicons", "cedar", "package.json"), "utf-8")) as {
      dependencies?: Record<string, string>;
    };
    expect(pkg.dependencies?.["@cedar-policy/cedar-wasm"]).toBe(CEDAR_WASM_VERSION);
  });

  it("refuses a language version other than the pinned one", () => {
    expect(() => assertPinnedLangVersion({ actual: "4.6", env: {} })).toThrow(/language version mismatch/);
  });

  it("proceeds with a warning under the accept env var", () => {
    const warnings: string[] = [];
    assertPinnedLangVersion({
      actual: "4.6",
      env: { CHANT_ACCEPT_CEDAR_LANG: "1" },
      warn: (m) => warnings.push(m),
    });
    expect(warnings).toHaveLength(1);
  });

  it("passes on a match", () => {
    expect(() => assertPinnedLangVersion()).not.toThrow();
  });
});

describe("content pin", () => {
  const { decls, resolved } = parseCedarSchema(readFileSync(defaultSchemaPath(), "utf-8"));
  const names = decls.map((d) => d.typeName).sort();

  it("matches the bundled default schema", () => {
    expect(resolvedSchemaDigest(resolved)).toBe(CEDAR_SCHEMA_PIN.digest);
    expect(names).toEqual([...PINNED_SCHEMA_NAMES]);
    expect(CEDAR_SCHEMA_PIN.declarations).toBe(names.length);
  });

  it("digests the resolved JSON, so reformatting the schema text does not move it", () => {
    const reformatted = readFileSync(defaultSchemaPath(), "utf-8").replace(/\n/g, "\n\n");
    expect(resolvedSchemaDigest(parseCedarSchema(reformatted).resolved)).toBe(CEDAR_SCHEMA_PIN.digest);
  });

  it("names what moved when it moves", () => {
    const drift = schemaDrift({ changed: true }, [...names, "App::Ghost"], names);
    expect(drift?.added).toEqual(["App::Ghost"]);
    expect(drift?.removed).toEqual([]);
  });

  it("refuses rather than regenerating against a schema nobody chose", () => {
    expect(() => assertPinnedSchema({ changed: true }, names, { env: {} })).toThrow(
      /no longer resolves to the pinned JSON/,
    );
  });

  it("warns instead under the accept env var", () => {
    const warnings: string[] = [];
    assertPinnedSchema({ changed: true }, names, {
      env: { CHANT_ACCEPT_CEDAR_SCHEMA: "1" },
      warn: (m) => warnings.push(m),
    });
    expect(warnings[0]).toMatch(/digest: "sha256:/);
  });
});
