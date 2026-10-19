/**
 * chant #4116: which failure messages are imports of packages the project has
 * not installed. The command paths that print the message have their own tests
 * (handlers/graph.test.ts, handlers/lint.test.ts, dependencies.e2e.test.ts).
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reportUninstalledDependencies, uninstalledDependencyIn } from "./dependencies";

let root: string;
let project: string;

const notFound = (pkg: string, file = "src/a.ts") => `Cannot find package '${pkg}' imported from ${join(project, file)}`;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "chant-4116-")));
  project = join(root, "proj");
  mkdirSync(join(project, "src"), { recursive: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

describe("uninstalledDependencyIn", () => {
  test("an @intentius package no node_modules holds, as lint and build report it", () => {
    expect(uninstalledDependencyIn(notFound("@intentius/chant-lexicon-aws"), project)).toEqual({
      package: "@intentius/chant-lexicon-aws",
      dir: project,
    });
    expect(uninstalledDependencyIn(`Component discovery error: ${notFound("@intentius/chant", "a.component.ts")}`, project)).toEqual({
      package: "@intentius/chant",
      dir: project,
    });
  });

  test("a subpath import names its package", () => {
    expect(uninstalledDependencyIn("Cannot find module '@intentius/chant/params' imported from /x/a.ts", project)?.package).toBe("@intentius/chant");
  });

  test("a package found in a parent node_modules is installed", () => {
    mkdirSync(join(root, "node_modules", "@intentius", "chant-lexicon-aws"), { recursive: true });
    expect(uninstalledDependencyIn(notFound("@intentius/chant-lexicon-aws"), project)).toBeUndefined();
  });

  test("a package found from the importing file's directory is installed", () => {
    const lexicon = join(root, "elsewhere", "lexicon");
    mkdirSync(join(root, "elsewhere", "node_modules", "@intentius", "chant"), { recursive: true });
    mkdirSync(lexicon, { recursive: true });
    expect(uninstalledDependencyIn(`Cannot find package '@intentius/chant' imported from ${join(lexicon, "index.ts")}`, project)).toBeUndefined();
  });

  test("another package counts only when the project's package.json declares it", () => {
    expect(uninstalledDependencyIn(notFound("lodahs"), project)).toBeUndefined();
    writeFileSync(join(project, "package.json"), JSON.stringify({ dependencies: { yaml: "*" } }));
    expect(uninstalledDependencyIn(notFound("yaml"), project)).toEqual({ package: "yaml", dir: project });
    expect(uninstalledDependencyIn(notFound("lodahs"), project)).toBeUndefined();
  });

  test("relative imports and other messages are not dependencies", () => {
    expect(uninstalledDependencyIn("Cannot find module './missing' imported from /x/a.ts", project)).toBeUndefined();
    expect(uninstalledDependencyIn("Exported declarable 'x' is never referenced", project)).toBeUndefined();
  });
});

describe("reportUninstalledDependencies", () => {
  let stderr: string[];
  beforeEach(() => {
    stderr = [];
    vi.spyOn(console, "error").mockImplementation((s: string) => void stderr.push(s));
  });

  test("names the first uninstalled package with the install hint; all when every message is one", () => {
    expect(reportUninstalledDependencies([notFound("@intentius/chant-lexicon-aws"), notFound("@intentius/chant")], project)).toBe("all");
    expect(stderr).toHaveLength(1);
    expect(stderr[0]).toContain(`dependencies not installed: @intentius/chant-lexicon-aws does not resolve from ${project}`);
    expect(stderr[0]).toContain("run npm install (or the project's package manager)");
  });

  test("some when other errors are beside them", () => {
    expect(reportUninstalledDependencies([notFound("@intentius/chant"), "a real problem"], project)).toBe("some");
    expect(stderr).toHaveLength(1);
  });

  test("prints nothing when no message is one", () => {
    expect(reportUninstalledDependencies(["a real problem"], project)).toBeUndefined();
    expect(reportUninstalledDependencies([], project)).toBeUndefined();
    expect(stderr).toEqual([]);
  });
});
