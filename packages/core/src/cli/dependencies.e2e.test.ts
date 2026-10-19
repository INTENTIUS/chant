/**
 * chant #4116, end to end through the real CLI: a project whose dependencies
 * are not installed is told so, and a project without node_modules that builds
 * today still builds.
 *
 * Both fixtures are temporary git repositories with no package.json install,
 * run with this checkout's chant from source the way
 * ../workspace/member-commands.e2e.test.ts runs it:
 *
 * - `bare` is a clone of a project like examples/fan-out-estate: its source
 *   imports `@intentius/chant-lexicon-k8s` and nothing installs it;
 * - `linked` is member-commands' setup: a node_modules holding only the
 *   lexicon, linked to this checkout, and no `@intentius/chant`. chant loads
 *   the lexicon, and the lexicon resolves `@intentius/chant` from its own
 *   location, so it builds. The first attempt at #4116 (#4118) refused it.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const REPO = realpathSync(join(import.meta.dirname, "..", "..", "..", ".."));
const LOADER = join(REPO, "node_modules", "tsx", "dist", "loader.mjs");
const MAIN = join(REPO, "packages", "core", "src", "cli", "main.ts");
const TIMEOUT = 240_000;

let root: string;

function chant(args: string[], cwd: string): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, ["--import", `file://${LOADER}`, MAIN, ...args], {
    cwd,
    encoding: "utf-8",
    timeout: TIMEOUT,
    env: { ...process.env, TSX_DISABLE_CACHE: "1", NO_COLOR: "1" },
    maxBuffer: 64 * 1024 * 1024,
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function project(name: string): string {
  const dir = join(root, name);
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  };
  write("chant.config.ts", 'export default { lexicons: ["k8s"] };\n');
  write(
    "src/infra.ts",
    'import { Namespace } from "@intentius/chant-lexicon-k8s";\nexport const appNs = new Namespace({ metadata: { name: "app" } });\n',
  );
  write(".gitignore", "node_modules\nout\n");
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: dir, stdio: "ignore" });
  git("init", "-q");
  git("add", "-A");
  git("commit", "-qm", "fixture");
  return dir;
}

let bare: string;
let linked: string;

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "chant-4116-e2e-")));
  bare = project("bare");
  linked = project("linked");
  mkdirSync(join(linked, "node_modules", "@intentius"), { recursive: true });
  symlinkSync(join(REPO, "lexicons", "k8s"), join(linked, "node_modules", "@intentius", "chant-lexicon-k8s"), "dir");
}, TIMEOUT);

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("dependencies not installed (#4116)", () => {
  test("graph says the dependencies are not installed, not that the source has lint errors", () => {
    const r = chant(["graph", "--format", "ir"], bare);
    expect(r.status, r.stderr).toBe(1);
    expect(r.stderr).toContain(`dependencies not installed: @intentius/chant-lexicon-k8s does not resolve from ${bare}`);
    expect(r.stderr).toContain("run npm install (or the project's package manager)");
    expect(r.stderr).not.toMatch(/lint errors/i);
    expect(r.stdout).toBe("");
  }, TIMEOUT);

  test("build and lint lead with the dependencies message and exit 1", () => {
    for (const verb of ["build", "lint"]) {
      const r = chant([verb], bare);
      expect(r.status, `${verb}: ${r.stderr}`).toBe(1);
      expect(r.stderr, verb).toContain("dependencies not installed: @intentius/chant-lexicon-k8s does not resolve from");
    }
  }, TIMEOUT);

  test("a project without @intentius/chant in node_modules that builds today still builds", () => {
    for (const args of [["build"], ["lint"], ["graph", "--format", "ir"]]) {
      const r = chant(args, linked);
      expect(r.status, `${args.join(" ")}: ${r.stderr}`).toBe(0);
      expect(r.stderr, args.join(" ")).not.toContain("dependencies not installed");
    }
  }, TIMEOUT);
});
