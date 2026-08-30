/**
 * Where `generate()` writes (#1696).
 *
 * The bug: the output went into this package's `src/generated/` no matter who
 * ran it, so a consumer's classes lived in `node_modules` and vanished on
 * `npm ci`. These tests generate into a throwaway project and check that
 * nothing lands under the package or under any `node_modules`.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { generate, generatedFiles, packageDir, resolveGeneratedDir, writeGeneratedFiles } from "./generate";
import { CEDAR_DEFAULT_OUT_DIR } from "../config";

const pkgDir = packageDir();

const PROJECT_SCHEMA = `namespace Shop {
  entity Customer = { "email": String };
  entity Order = { "owner": Customer, "total": Long };
  action view, cancel appliesTo {
    principal: [Customer],
    resource: [Order],
    context: { "mfa": Bool }
  };
}
`;

/** Every file under `dir`, relative, sorted. */
function tree(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (d: string, prefix: string): void => {
    for (const entry of readdirSync(d).sort()) {
      const full = join(d, entry);
      const rel = prefix ? `${prefix}/${entry}` : entry;
      if (statSync(full).isDirectory()) walk(full, rel);
      else out.push(rel);
    }
  };
  walk(dir, "");
  return out;
}

/** Modification times of the package's own generated files, to prove they were not touched. */
function packageGeneratedMtimes(): Map<string, number> {
  const dir = join(pkgDir, "src", "generated");
  return new Map(tree(dir).map((f) => [f, statSync(join(dir, f)).mtimeMs]));
}

describe("resolveGeneratedDir", () => {
  it("keeps the package's own output at src/generated when the project is the package", () => {
    expect(resolveGeneratedDir({ projectRoot: pkgDir })).toBe(resolve(pkgDir, "src", "generated"));
  });

  it("sends a consumer project to src/generated/cedar under its own root", () => {
    const root = join(tmpdir(), "some-consumer");
    expect(resolveGeneratedDir({ projectRoot: root })).toBe(resolve(root, CEDAR_DEFAULT_OUT_DIR));
  });

  it("honours cedar.outDir, relative to the project root", () => {
    const root = join(tmpdir(), "some-consumer");
    expect(resolveGeneratedDir({ projectRoot: root, config: { outDir: "authz/generated" } })).toBe(
      resolve(root, "authz", "generated"),
    );
  });

  it("honours an absolute cedar.outDir as given", () => {
    const abs = join(tmpdir(), "elsewhere");
    expect(resolveGeneratedDir({ projectRoot: pkgDir, config: { outDir: abs } })).toBe(abs);
  });

  it("never resolves a consumer into the installed package", () => {
    // The shape of the bug: a consumer whose node_modules holds this package.
    const root = join(tmpdir(), "consumer");
    const dir = resolveGeneratedDir({ projectRoot: root });
    expect(dir.startsWith(root)).toBe(true);
    expect(dir.includes("node_modules")).toBe(false);
    expect(dir.startsWith(pkgDir)).toBe(false);
  });
});

describe("writeGeneratedFiles into a consumer project", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "cedar-consumer-"));
    mkdirSync(join(root, "node_modules", "@intentius", "chant-lexicon-cedar", "src"), { recursive: true });
    writeFileSync(join(root, "schema.cedarschema"), PROJECT_SCHEMA);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("writes the project's classes under the project, and nothing under node_modules or the package", async () => {
    const before = packageGeneratedMtimes();

    const result = await generate({ projectRoot: root });
    const outDir = resolveGeneratedDir({ projectRoot: root });
    writeGeneratedFiles(result, outDir);

    expect(tree(outDir)).toEqual(["index.d.ts", "index.ts", "lexicon-cedar.json", "runtime.ts"]);
    expect(tree(join(root, "node_modules"))).toEqual([]);
    expect(packageGeneratedMtimes()).toEqual(before);

    // And what was written is the project's schema, not the bundled default.
    const index = readFileSync(join(outDir, "index.ts"), "utf-8");
    expect(index).toContain('"Shop::Order"');
    expect(index).toContain("CancelAction");
    expect(index).not.toContain('"App::Document"');
  });

  it("is self-contained: the generated tree imports only from @intentius/chant", async () => {
    // A consumer's copy cannot reach back into this package by relative path.
    const result = await generate({ projectRoot: root });
    for (const [name, content] of Object.entries(generatedFiles(result))) {
      if (!name.endsWith(".ts")) continue;
      const specifiers = [...content.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
      for (const spec of specifiers) {
        expect(spec === "./runtime" || spec.startsWith("@intentius/chant/"), `${name} imports ${spec}`).toBe(true);
      }
    }
  });

  it("follows cedar.outDir when the config sets one", async () => {
    const config = { schema: "schema.cedarschema", outDir: "src/authz/generated" };
    const result = await generate({ projectRoot: root, config });
    const outDir = resolveGeneratedDir({ projectRoot: root, config });
    writeGeneratedFiles(result, outDir);

    expect(outDir).toBe(join(root, "src", "authz", "generated"));
    expect(existsSync(join(outDir, "index.ts"))).toBe(true);
    expect(existsSync(join(root, CEDAR_DEFAULT_OUT_DIR))).toBe(false);
  });
});
