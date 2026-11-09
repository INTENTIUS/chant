/**
 * #4794: one source-dir rule. `chant build` with no path builds the config's
 * `sourceDir`, else the project root, as `resolveSourceDir` says for every
 * command; and a root build leaves a top-level `scripts/` out unless
 * `include` brings it back. Test files stay out of every build.
 */
import { describe, test, expect } from "vitest";
import { join, relative, resolve } from "node:path";
import { buildPathOf } from "./build";
import { discover } from "../../discovery/index";
import { findInfraFiles } from "../../discovery/files";
import { configuredSourceDir, resolveSourceDir } from "../../config";

const fixtures = resolve(import.meta.dirname, "../commands/__fixtures__");
const root = join(fixtures, "source-dir-root");
const scoped = join(fixtures, "source-dir-scoped");
const include = join(fixtures, "source-dir-include");

const loaded = async (path: string, from: string): Promise<string[]> => {
  const result = await discover(path);
  expect(result.errors.map((e) => String(e))).toEqual([]);
  return result.sourceFiles.map((f) => relative(from, f).split("\\").join("/")).sort();
};

describe("resolveSourceDir (#4794)", () => {
  test("an explicit path wins, then sourceDir, then the project root", () => {
    expect(resolveSourceDir("/p", { sourceDir: "ci" }, "other")).toBe(resolve("/p/other"));
    expect(resolveSourceDir("/p", { sourceDir: "ci" })).toBe(resolve("/p/ci"));
    expect(resolveSourceDir("/p", {})).toBe(resolve("/p"));
    expect(resolveSourceDir("/p", undefined)).toBe(resolve("/p"));
    expect(configuredSourceDir({})).toBe(".");
    expect(configuredSourceDir({ sourceDir: "src" })).toBe("src");
  });
});

describe("a root build (#4794)", () => {
  test("a project with scripts/ and no sourceDir builds without loading it, nor its test files", async () => {
    expect(await loaded(root, root)).toEqual(["infra.ts"]);
  });

  test("include brings scripts/ back", async () => {
    expect((await findInfraFiles(include)).map((f) => relative(include, f).split("\\").join("/")).sort()).toEqual(["infra.ts", "scripts/run-on-load.ts"]);
  });

  test("an explicit path below the root is not a root build", async () => {
    expect((await findInfraFiles(join(root, "scripts"))).map((f) => relative(root, f))).toEqual([join("scripts", "run-on-load.ts")]);
  });
});

describe("chant build's path (#4794)", () => {
  test("with no path, at a project that sets sourceDir, it builds only that directory", async () => {
    const path = await buildPathOf({ path: scoped, pathGiven: false });
    expect(path).toBe(join(scoped, "infra"));
    expect(await loaded(path, scoped)).toEqual(["infra/net.ts"]);
  });

  test("a path argument wins over sourceDir", async () => {
    expect(await buildPathOf({ path: scoped, pathGiven: true })).toBe(scoped);
  });

  test("with no sourceDir it is the path it was given, as before", async () => {
    expect(await buildPathOf({ path: root, pathGiven: false })).toBe(root);
  });
});
