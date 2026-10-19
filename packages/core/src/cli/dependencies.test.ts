/**
 * chant #4116: a project whose dependencies are not installed is told so,
 * not told its source has lint errors.
 */
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { runCommandInProcess } from "./main";
import { findMissingDependency } from "./dependencies";

// Plain node_modules lookup up the directory tree, which is what node resolution
// does for these packages. The real resolveFromProject goes through tsx's
// tsconfig-paths hook under vitest (registered with the repository's tsconfig,
// which maps @intentius/*), and that finds the monorepo sources from anywhere.
vi.mock("../lexicon-module", async (importActual) => {
  const actual = await importActual<typeof import("../lexicon-module")>();
  return {
    ...actual,
    resolveFromProject(spec: string, fromDir: string = process.cwd()): string | undefined {
      for (let dir = fromDir; ; dir = dirname(dir)) {
        const candidate = join(dir, "node_modules", ...spec.split("/"), "package.json");
        if (existsSync(candidate)) return candidate;
        if (dirname(dir) === dir) return undefined;
      }
    },
  };
});

function fakePackage(root: string, name: string): void {
  const dir = join(root, "node_modules", ...name.split("/"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version: "0.0.0", main: "index.js" }));
  writeFileSync(join(dir, "index.js"), "module.exports = {};\n");
}

describe("dependencies not installed (#4116)", () => {
  let root: string;
  let project: string;
  let stderr: string[];

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "chant-4116-")));
    project = join(root, "proj");
    mkdirSync(join(project, "src"), { recursive: true });
    writeFileSync(join(project, "chant.config.ts"), 'export default { lexicons: ["aws"] };\n');
    writeFileSync(join(project, "src", "a.ts"), 'import { Bucket } from "@intentius/chant-lexicon-aws";\nexport const b = new Bucket({});\n');
    stderr = [];
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void stderr.push(a.join(" ")));
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  test("graph prints the dependencies message and exits 1", async () => {
    const code = await runCommandInProcess(["graph", project, "--format", "ir"]);
    expect(code).toBe(1);
    const out = stderr.join("\n");
    expect(out).toContain(`dependencies not installed: @intentius/chant does not resolve from ${project}`);
    expect(out).toContain("run npm install (or the project's package manager)");
    expect(out).not.toMatch(/lint errors/i);
  });

  test("build prints the dependencies message and exits 1", async () => {
    await expect(runCommandInProcess(["build", project])).rejects.toThrow("exit 1");
    const out = stderr.join("\n");
    expect(out).toContain("dependencies not installed: @intentius/chant does not resolve from");
    expect(out).not.toMatch(/lint errors/i);
  });

  test("lint prints the dependencies message and exits 1", async () => {
    const code = await runCommandInProcess(["lint", project]);
    expect(code).toBe(1);
    expect(stderr.join("\n")).toContain("dependencies not installed: @intentius/chant does not resolve from");
  });

  test("names the first missing package: a lexicon when chant itself resolves", async () => {
    fakePackage(root, "@intentius/chant");
    expect(await findMissingDependency(project)).toEqual({ package: "@intentius/chant-lexicon-aws", dir: project });
  });

  test("a project resolving from a parent node_modules is not refused", async () => {
    fakePackage(root, "@intentius/chant");
    fakePackage(root, "@intentius/chant-lexicon-aws");
    expect(await findMissingDependency(project)).toBeUndefined();
  });
});
