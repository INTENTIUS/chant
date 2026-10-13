import { afterEach, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { walkDiscovery, workspaceMemberDirs, type DiscoveryWalker } from "./walk";
import { findInfraFiles } from "./files";
import { discoverOps } from "../op/discover";
import type { DiscoveryGlobs } from "../config";
import { auditCommand } from "../cli/commands/audit";

/**
 * chant#2527: one discovery walk. Every walker skips dot-directories, `dist`
 * and git-ignored paths, stops at child projects inside a project, reads
 * every child project outside one, and lets `include` re-admit what it skips.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tree(files: Record<string, string>, opts: { git?: boolean } = {}): string {
  const root = mkdtempSync(join(tmpdir(), "chant-2527-"));
  dirs.push(root);
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  if (opts.git) execFileSync("git", ["init", "-q"], { cwd: root });
  return root;
}

const WALKERS: DiscoveryWalker[] = ["source", "lint", "components", "ops", "audit"];

function walk(walker: DiscoveryWalker, root: string, globs?: Partial<DiscoveryGlobs>): string[] {
  return walkDiscovery({
    walker,
    root,
    accept: (name) => name.endsWith(".ts"),
    globs: globs ? { root, exclude: [], include: [], ...globs } : undefined,
  })
    .map((f) => relative(root, f).split("\\").join("/"))
    .sort();
}

describe("the rules every walker shares (#2527)", () => {
  test.each(WALKERS)("%s skips dot-directories, dist and node_modules", (walker) => {
    const root = tree({
      "a.ts": "",
      ".cache/b.ts": "",
      "dist/c.ts": "",
      "src/dist/d.ts": "",
      "node_modules/x/e.ts": "",
      ".github/f.ts": "",
    });
    const expected = walker === "audit" ? [".github/f.ts", "a.ts"] : ["a.ts"];
    expect(walk(walker, root)).toEqual(expected);
  });

  test.each(WALKERS)("%s skips git-ignored paths, nested .gitignore included", (walker) => {
    const root = tree(
      {
        ".gitignore": "vendor/\n",
        "a.ts": "",
        "vendor/b.ts": "",
        "pkg/.gitignore": "gen.ts\n",
        "pkg/gen.ts": "",
        "pkg/keep.ts": "",
      },
      { git: true },
    );
    expect(walk(walker, root)).toEqual(["a.ts", "pkg/keep.ts"]);
  });

  test("a scan root that is itself ignored is read", () => {
    const root = tree({ ".gitignore": "/carveout/\n", "carveout/src/main.ts": "" }, { git: true });
    const src = join(root, "carveout", "src");
    expect(walk("lint", src)).toEqual(["main.ts"]);
  });

  test("a tree outside git is read without ignore rules", () => {
    const root = tree({ ".gitignore": "*.ts\n", "a.ts": "" });
    expect(walk("source", root)).toEqual(["a.ts"]);
  });
});

describe("child projects (#2527)", () => {
  const files = {
    "chant.config.ts": "export default {};\n",
    "main.ts": "",
    "east/chant.config.ts": "export default {};\n",
    "east/e.ts": "",
    "west/chant.config.json": JSON.stringify({ lexicons: ["aws"] }),
    "west/w.ts": "",
    "lintonly/chant.config.json": JSON.stringify({ rules: { COR004: "off" } }),
    "lintonly/l.ts": "",
  };

  test.each(WALKERS)("inside a project, %s stops at every child project, .json configs included, and not at a lint-only fragment", (walker) => {
    const root = tree(files);
    expect(walk(walker, root)).toEqual(["chant.config.ts", "lintonly/l.ts", "main.ts"]);
  });

  test("the first-config quirk is gone: no child project is read as the project's own source", () => {
    const root = tree({ "chant.config.ts": "export default {};\n", "src/chant.config.ts": "export default {};\n", "src/a.ts": "", "zz/chant.config.ts": "export default {};\n", "zz/b.ts": "" });
    expect(walk("source", root)).toEqual(["chant.config.ts"]);
  });

  test.each(["source", "components", "lint"] as DiscoveryWalker[])("outside a project, %s reads every child project", (walker) => {
    const root = tree({ "package.json": "{}", "a/chant.config.ts": "", "a/x.ts": "", "b/chant.config.ts": "", "b/y.ts": "" });
    expect(walk(walker, root)).toEqual(["a/chant.config.ts", "a/x.ts", "b/chant.config.ts", "b/y.ts"]);
  });

  test("Op discovery stops at child projects even with no config at its root", () => {
    const root = tree({ "package.json": "{}", "a/chant.config.ts": "", "a/x.ts": "", "top.ts": "" });
    expect(walk("ops", root)).toEqual(["top.ts"]);
  });

  test("discoverOps from a configless git root does not collect a sibling project's Ops", async () => {
    const root = tree(
      {
        "ops/local.op.ts": `export default { props: { name: "local", phases: [] } };\n`,
        "sibling/chant.config.json": JSON.stringify({ lexicons: ["aws"] }),
        "sibling/ops/theirs.op.ts": `export default { props: { name: "theirs", phases: [] } };\n`,
      },
      { git: true },
    );
    const { ops, errors } = await discoverOps({ cwd: root });
    expect(errors).toEqual([]);
    expect([...ops.keys()]).toEqual(["local"]);
  });
});

describe("include and exclude (#2519, #2527)", () => {
  test("include re-admits a dot-directory, dist, an ignored path and a child project", () => {
    const root = tree(
      {
        "chant.config.ts": "export default {};\n",
        ".gitignore": "gen/\n",
        ".cache/a.ts": "",
        "dist/b.ts": "",
        "gen/c.ts": "",
        "stack/chant.config.ts": "",
        "stack/d.ts": "",
        "main.ts": "",
      },
      { git: true },
    );
    expect(walk("source", root)).toEqual(["chant.config.ts", "main.ts"]);
    expect(walk("source", root, { include: [".cache", "dist/b.ts", "gen", "stack"] })).toEqual([
      ".cache/a.ts",
      "chant.config.ts",
      "dist/b.ts",
      "gen/c.ts",
      "main.ts",
      "stack/chant.config.ts",
      "stack/d.ts",
    ]);
  });

  test("an include below a skipped directory reads only what it names there", () => {
    const root = tree({ ".tool/keep/a.ts": "", ".tool/drop/b.ts": "", ".tool/c.ts": "" });
    expect(walk("source", root, { include: [".tool/keep/**"] })).toEqual([".tool/keep/a.ts"]);
  });

  test("exclude drops files, include wins over it, and include never reaches node_modules", () => {
    const root = tree({ "ops/run.ts": "", "ops/stack.ts": "", "node_modules/x/a.ts": "", "main.ts": "" });
    expect(walk("ops", root, { exclude: ["ops"], include: ["ops/stack.ts", "node_modules"] })).toEqual(["main.ts", "ops/stack.ts"]);
  });

  test("findInfraFiles reads include from the project config", async () => {
    const root = tree({
      "chant.config.json": JSON.stringify({ lexicons: ["aws"], include: ["src"] }),
      "src/chant.config.ts": "export default { lint: {} };\n",
      "src/a.ts": "",
    });
    const files = (await findInfraFiles(root)).map((f) => relative(root, f)).sort();
    expect(files).toEqual(["src/a.ts", "src/chant.config.ts"]);
  });
});

describe("workspace members and groups (#2525 rule 3, read by #2534's reader)", () => {
  test("nothing is excluded without a workspace declaration", async () => {
    const root = tree({ "chant.config.json": JSON.stringify({ lexicons: ["aws"] }), "members/a/x.ts": "" }, { git: true });
    expect(await workspaceMemberDirs(root)).toEqual([]);
  });

  test("with chant.workspace.json, member directories below the scan root leave the walk", async () => {
    const root = tree(
      {
        "chant.workspace.json": JSON.stringify({
          name: "w",
          schema: 1,
          members: [
            { name: "root", dir: ".", kind: "chant" },
            { name: "a", dir: "members/a", kind: "chant" },
          ],
        }),
        "main.ts": "",
        "members/a/x.ts": "",
        "members/b/y.ts": "",
      },
      { git: true },
    );
    const excludeDirs = await workspaceMemberDirs(root);
    expect(excludeDirs.map((d) => relative(root, d))).toEqual(["members/a"]);
    const files = walkDiscovery({ walker: "source", root, accept: (n) => n.endsWith(".ts"), excludeDirs, globs: { root, exclude: [], include: ["members"] } });
    expect(files.map((f) => relative(root, f)).sort()).toEqual(["main.ts", "members/b/y.ts"]);
    // Scanned from inside the member, the member is the project and is read.
    expect(await workspaceMemberDirs(join(root, "members", "a"))).toEqual([]);
  });

  test("an example group's matches leave the walk too, and a .jsonc declaration counts", async () => {
    const root = tree(
      {
        "chant.workspace.jsonc": `{
          // groups are read through #2534's declaration reader
          "name": "w",
          "schema": 1,
          "members": [
            { "name": "root", "dir": ".", "kind": "chant" },
            { "name": "examples", "kind": "examples", "glob": "examples/*" },
          ],
        }`,
        "main.ts": "",
        "examples/one/chant.config.ts": "export default {};",
        "examples/one/x.ts": "",
        "examples/notes/readme.ts": "",
      },
      { git: true },
    );
    const excludeDirs = await workspaceMemberDirs(root);
    // `examples/notes` holds no chant project, so the group leaves it alone.
    expect(excludeDirs.map((d) => relative(root, d))).toEqual(["examples/one"]);
  });

  test("chant audit at the workspace root leaves members out", async () => {
    const root = tree(
      {
        "chant.workspace.json": JSON.stringify({
          name: "w",
          schema: 1,
          members: [
            { name: "root", dir: ".", kind: "chant" },
            { name: "a", dir: "members/a", kind: "chant" },
          ],
        }),
        "terraform.tfstate": "{}",
        "members/a/terraform.tfstate": "{}",
      },
      { git: true },
    );
    // No lexicons: TF023 still runs, and its paths show what the walk read.
    const result = await auditCommand({ path: root, format: "json", plugins: [] });
    expect(result.findings.filter((f) => f.checkId === "TF023").map((f) => f.file)).toEqual(["terraform.tfstate"]);
  });

  test("a declaration that fails to read excludes nothing", async () => {
    const root = tree({ "chant.workspace.json": "{ not json", "members/a/x.ts": "" }, { git: true });
    expect(await workspaceMemberDirs(root)).toEqual([]);
  });
});
