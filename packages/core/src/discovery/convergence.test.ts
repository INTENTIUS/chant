import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { findInfraFiles } from "./files";
import { resetDiscoveryWarnings, warnDiscoveryChanges } from "./convergence";
import { discoverComponents } from "../components/discover";

/**
 * chant#2527's warning release. Each category of file whose discovery status
 * changes when the walkers converge gets a warning naming the file, the
 * change and the glob that keeps today's behaviour, while the walker's
 * returned list stays exactly what it is today. Lint's category lives in
 * `../cli/commands/lint.test.ts`, the Op category in
 * `../op/discover-convergence.test.ts`.
 */

let dir: string;
let stderr: string[];

function write(rel: string, body = "export const x = 1;\n"): void {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), body);
}

/** A project config (it declares a project-level key, so it is no lint-only fragment). */
function project(rel = ".", extra: Record<string, unknown> = {}): void {
  write(join(rel, "chant.config.json"), JSON.stringify({ lexicons: ["aws"], ...extra }));
}

const rel = (files: string[]): string[] => files.map((f) => f.slice(dir.length + 1)).sort();

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "chant-2527-")));
  resetDiscoveryWarnings();
  stderr = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void stderr.push(args.join(" ")));
  vi.spyOn(process, "cwd").mockReturnValue(dir);
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe("source discovery warns about files the converged walker reads differently (#2527)", () => {
  test("a .ts file in a dot-directory", async () => {
    project();
    write("src/app.ts");
    write(".cache/gen.ts");

    expect(rel(await findInfraFiles(dir))).toEqual([".cache/gen.ts", "src/app.ts"]);
    expect(stderr).toEqual([
      "warning: Source discovery (build, graph, list, explain) under the current directory changes in the next release (chant#2527):\n" +
        "  .cache/gen.ts: .cache/ is a dot-directory. Every walker skips dot-directories from the next release. " +
        'To keep reading it after the change, add ".cache" to include in chant.config.json, which the next release honours.',
    ]);
  });

  test("a git-ignored .ts file, ignored by a nested .gitignore", async () => {
    execFileSync("git", ["init", "-q"], { cwd: dir });
    project();
    write("src/app.ts");
    write("src/vendored.ts");
    write("src/.gitignore", "vendored.ts\n");

    expect(rel(await findInfraFiles(dir))).toEqual(["src/app.ts", "src/vendored.ts"]);
    expect(stderr).toHaveLength(1);
    expect(stderr[0]).toContain(
      "  src/vendored.ts is git-ignored. Every walker skips git-ignored files from the next release. " +
        'To keep reading it after the change, add "src/vendored.ts" to include in chant.config.json, which the next release honours.',
    );
  });

  test("an ignored directory is named once, by its outermost ignored path", async () => {
    execFileSync("git", ["init", "-q"], { cwd: dir });
    project();
    write("src/app.ts");
    write(".gitignore", "vendor/\n");
    for (const name of ["a", "b", "c", "d"]) write(`vendor/lib/${name}.ts`);

    expect(rel(await findInfraFiles(dir))).toHaveLength(5);
    expect(stderr[0]).toContain("  4 files under vendor/: vendor/ is git-ignored.");
    expect(stderr[0]).toContain('add "vendor" to include in chant.config.json.');
  });

  test("a .ts file under dist", async () => {
    project();
    write("src/app.ts");
    write("dist/out.ts");

    expect(rel(await findInfraFiles(dir))).toEqual(["dist/out.ts", "src/app.ts"]);
    expect(stderr[0]).toContain(
      "  dist/out.ts: dist/ is a dist directory. Every walker skips dist from the next release. " +
        'To keep reading it after the change, add "dist" to include in chant.config.json, which the next release honours.',
    );
  });

  test("a nested child project whose chant.config.json declares a project", async () => {
    project();
    write("src/app.ts");
    project("stacks/east");
    write("stacks/east/east.ts");
    // A lint-only fragment is not a boundary: no warning for this one.
    write("stacks/west/chant.config.json", JSON.stringify({ rules: { COR004: "off" } }));
    write("stacks/west/west.ts");

    expect(rel(await findInfraFiles(dir))).toEqual(["src/app.ts", "stacks/east/east.ts", "stacks/west/west.ts"]);
    expect(stderr).toHaveLength(1);
    expect(stderr[0]).toContain(
      "  stacks/east/east.ts: stacks/east/ is a child project with its own chant.config. " +
        "Discovery stops at child projects from the next release. " +
        'To keep reading it after the change, add "stacks/east" to include in chant.config.json, which the next release honours.',
    );
    expect(stderr[0]).not.toContain("west");
  });

  test("the first child project met is no longer read as the project's own source (the quirk)", async () => {
    project();
    write("app/chant.config.ts", "export default {};\n");
    write("app/main.ts");

    expect(rel(await findInfraFiles(dir))).toEqual(["app/chant.config.ts", "app/main.ts"]);
    expect(stderr[0]).toContain(
      "  app/chant.config.ts, app/main.ts: app/ is a child project with its own chant.config, " +
        "read today as this project's own source because the walk met it first. " +
        "From the next release discovery stops there, as at any child project. " +
        'To keep reading them after the change, add "app" to include in chant.config.json, which the next release honours.',
    );
  });

  test("the glob in the config is the fix: with it, nothing is printed and the list is the same", async () => {
    project(".", { include: [".cache", "dist"] });
    write("src/app.ts");
    write(".cache/gen.ts");
    write("dist/out.ts");

    expect(rel(await findInfraFiles(dir))).toEqual([".cache/gen.ts", "dist/out.ts", "src/app.ts"]);
    expect(stderr).toEqual([]);
  });

  test("a clean project prints nothing", async () => {
    execFileSync("git", ["init", "-q"], { cwd: dir });
    project();
    write(".gitignore", "node_modules/\n.chant/types/\n");
    write("src/app.ts");
    write("src/lib/util.ts");
    write("node_modules/dep/index.ts");
    // chant init's generated type stubs: read today, never worth a warning.
    write(".chant/types/core/index.d.ts");

    expect(rel(await findInfraFiles(dir))).toEqual([".chant/types/core/index.d.ts", "src/app.ts", "src/lib/util.ts"]);
    expect(stderr).toEqual([]);
  });

  test("a warning prints once per process, however often the tree is walked", async () => {
    project();
    write(".cache/gen.ts");
    await findInfraFiles(dir);
    await findInfraFiles(dir);
    expect(stderr).toHaveLength(1);
  });
});

describe("component discovery outside a project reads every child project next release (#2527)", () => {
  test("the second child project's component is named, with the exclude glob", async () => {
    // No config and no .git/package.json at or above `dir`: outside a project.
    write("one/chant.config.ts", "export default {};\n");
    write("one/one.component.ts");
    write("two/chant.config.ts", "export default {};\n");
    write("two/two.component.ts");

    const { sourceFiles } = await discoverComponents(dir);
    // Today: whichever child the walk met first, and only that one.
    expect(sourceFiles).toHaveLength(1);
    const [read] = rel(sourceFiles);
    const skipped = read.startsWith("one/") ? "two" : "one";

    expect(stderr).toHaveLength(1);
    expect(stderr[0]).toContain(
      `warning: Component discovery under the current directory changes in the next release (chant#2527):\n` +
        `  ${skipped}/${skipped}.component.ts: ${skipped}/ is a child project, skipped today ` +
        "because the walk met another child project first. From the next release every child project is read, " +
        "since the current directory is not inside a chant project. " +
        `To keep skipping it, add "${skipped}" to exclude in chant.config.ts (a new file).`,
    );
  });
});

describe("the audit walk (#2527)", () => {
  test("warns about a git-ignored candidate and leaves Terraform state to TF023", async () => {
    execFileSync("git", ["init", "-q"], { cwd: dir });
    write(".gitignore", ".env\n");
    write(".env", "TOKEN=x\n");
    write("k8s/deploy.yaml", "kind: Deployment\n");

    const lines = await warnDiscoveryChanges({
      walker: "audit",
      root: dir,
      files: [join(dir, ".env"), join(dir, "k8s/deploy.yaml"), join(dir, ".github/workflows/ci.yml")],
    });
    expect(lines).toEqual([
      "  .env is git-ignored. Every walker skips git-ignored files from the next release. " +
        'To keep reading it after the change, add ".env" to include in chant.config.ts (a new file), which the next release honours.',
    ]);
  });
});
