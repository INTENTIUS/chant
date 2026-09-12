import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { foldProject } from "../index";

/**
 * chant#2438 — a host package that is not a chant lexicon.
 *
 * `FoldSession.lexiconPackages` is the entire allowlist a bare import is
 * followed into, matched by text, and it has only ever been built from
 * `@intentius/chant-lexicon-<name>`. That covers every chant project, because
 * a chant project's active packages are exactly that.
 *
 * It does not cover a caller driving the fold path against a host of its own.
 * The specification's conformance harness is the first: its `shapes` host owns
 * `@tsad/shapes`, a name the convention cannot spell, so all twenty-five of its
 * hosted whole-build fixtures were unanswerable at chant and reported skipped.
 *
 * `FoldProjectOptions.lexiconPackages` names such a package outright. The
 * boundary is unchanged: still an allowlist the caller states, still matched by
 * text, still empty by default.
 */
describe("foldProject — a host package outside the lexicon convention (chant#2438)", () => {
  let root: string;

  /** A project with a real `@tsad/shapes` in its own `node_modules`. */
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "chant-host-pkg-"));
    const pkg = join(root, "node_modules", "@tsad", "shapes");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(
      join(pkg, "package.json"),
      JSON.stringify({ name: "@tsad/shapes", version: "1.0.0", type: "module", main: "index.js" }),
    );
    writeFileSync(join(pkg, "index.js"), "export const SIZES = { small: 1, large: 3 };\n");
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const app = (source: string): string => {
    const file = join(root, "app.ts");
    writeFileSync(file, source);
    return file;
  };

  test("is not followed without being named, which is the pre-#2438 answer", async () => {
    const file = app('import { SIZES } from "@tsad/shapes";\nexport const s = SIZES.large;\n');
    const verdict = (await foldProject([file])).get(file)!;

    expect(verdict.verdict).toBe("run");
    expect(verdict.reason).toContain("unresolved identifier: SIZES");
  });

  test("is followed when named, and the data export folds as a value", async () => {
    const file = app('import { SIZES } from "@tsad/shapes";\nexport const s = SIZES.large;\n');
    const verdict = (await foldProject([file], [], { lexiconPackages: ["@tsad/shapes"] })).get(file)!;

    // The specification's `F-Host-DataExports/plain-data-export` fixture, and
    // its `expect.json`, are exactly this.
    expect(verdict.verdict).toBe("fold");
    expect(Object.fromEntries(verdict.exports!)).toEqual({ s: 3 });
  });

  test("naming one package does not open any other", async () => {
    const other = join(root, "node_modules", "@tsad", "elsewhere");
    mkdirSync(other, { recursive: true });
    writeFileSync(
      join(other, "package.json"),
      JSON.stringify({ name: "@tsad/elsewhere", version: "1.0.0", type: "module", main: "index.js" }),
    );
    writeFileSync(join(other, "index.js"), "export const OTHER = 9;\n");

    const file = app('import { OTHER } from "@tsad/elsewhere";\nexport const s = OTHER;\n');
    const verdict = (await foldProject([file], [], { lexiconPackages: ["@tsad/shapes"] })).get(file)!;

    expect(verdict.verdict).toBe("run");
  });

  test("sits alongside `lexicons`, rather than replacing it", async () => {
    const file = app('import { SIZES } from "@tsad/shapes";\nexport const s = SIZES.small;\n');
    const verdict = (
      await foldProject([file], [], { lexicons: ["aws"], lexiconPackages: ["@tsad/shapes"] })
    ).get(file)!;

    expect(verdict.verdict).toBe("fold");
    expect(Object.fromEntries(verdict.exports!)).toEqual({ s: 1 });
  });
});
