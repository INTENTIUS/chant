import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdir, writeFile, rm, symlink, realpath } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { SKIP_MARKER } from "../discovery/files";

/**
 * chant #2519 — a project keeps a runnable `.ts` script with top-level side
 * effects next to its declarations, and whole-project commands neither import
 * nor lint it once the project says so, with an `exclude` glob or the skip
 * marker.
 *
 * The script is the one from the issue: it reads `process.argv` as an Op name
 * and exits the process with code 2. Imported by discovery, it reads chant's
 * own argv and ends the command, which is what the first test shows. It also
 * writes a file, so "imported" is visible apart from the exit code, and it
 * indexes `process.env` dynamically, which EVL003 flags, so "linted" is
 * visible in lint output.
 *
 * End-to-end through the real CLI (`main.ts`, spawned as `bin/chant` spawns
 * it): an in-process `build()` would be killed by the script's `process.exit`,
 * and the point is that every command's own path honours the setting.
 */

const thisDir = dirname(fileURLToPath(import.meta.url));
const mainTsPath = resolve(thisDir, "main.ts");
const repoRoot = resolve(thisDir, "../../../..");
/** One CLI run can take a minute on a loaded CI runner, and a test makes up to three. */
const SPAWN_TIMEOUT = 150_000;
const TIMEOUT = 3 * SPAWN_TIMEOUT + 30_000;

describe("CLI end-to-end — discovery skips a side-effecting script (#2519)", () => {
  let testDir: string;
  let ranPath: string;

  /** Write the project config; `extra` is spliced into the default export. */
  async function writeConfig(extra: string): Promise<void> {
    await writeFile(join(testDir, "chant.config.ts"), `export default { lexicons: ["k8s"]${extra} };\n`);
  }

  /** The runner from the issue, optionally headed by `header`. */
  async function writeRunner(header = ""): Promise<void> {
    await writeFile(
      join(testDir, "ops", "run.ts"),
      [
        header,
        'import { writeFileSync } from "node:fs";',
        "const op = process.argv[2];",
        "const target = process.env[`OP_${op}`];",
        `writeFileSync(${JSON.stringify(ranPath)}, String(op));`,
        'console.error(`no op named "${op}"`, target ?? "");',
        "process.exit(2);",
        "",
      ].join("\n"),
    );
  }

  beforeEach(async () => {
    testDir = await realpath(
      await (async () => {
        const dir = join(tmpdir(), `chant-discovery-skip-test-${Date.now()}-${Math.random()}`);
        await mkdir(join(dir, "src"), { recursive: true });
        await mkdir(join(dir, "ops"), { recursive: true });
        return dir;
      })(),
    );
    ranPath = join(testDir, "runner-ran.txt");

    await mkdir(join(testDir, "node_modules", "@intentius"), { recursive: true });
    await symlink(
      join(repoRoot, "lexicons", "k8s"),
      join(testDir, "node_modules", "@intentius", "chant-lexicon-k8s"),
      "dir",
    );
    await writeFile(
      join(testDir, "src", "infra.ts"),
      [
        'import { Namespace } from "@intentius/chant-lexicon-k8s";',
        'export const ns = new Namespace({ metadata: { name: "discovery-skip" } });',
        "",
      ].join("\n"),
    );
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  function runCli(args: string[]): { status: number | null; stdout: string; stderr: string } {
    const result = spawnSync("npx", ["tsx", mainTsPath, ...args], {
      cwd: repoRoot,
      encoding: "utf-8",
      timeout: SPAWN_TIMEOUT,
    });
    return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  }

  test("without exclude or the marker, the script runs under `chant build` and ends it", async () => {
    await writeConfig("");
    await writeRunner();

    const { status, stderr } = runCli(["build", testDir]);

    expect(status).toBe(2);
    expect(stderr).toContain('no op named "build"');
    expect(existsSync(ranPath)).toBe(true);
  }, TIMEOUT);

  test("an `exclude` glob keeps build and lint out of the script", async () => {
    await writeConfig(', exclude: ["ops/**"]');
    await writeRunner();

    const build = runCli(["build", testDir]);
    expect(build.stderr).not.toContain("no op named");
    expect(build.status).toBe(0);
    expect(build.stdout).toContain("name: discovery-skip");

    const lint = runCli(["lint", testDir, "--format", "json"]);
    expect(lint.status).toBe(0);
    const diagnostics = JSON.parse(lint.stdout) as Array<{ file: string }>;
    expect(diagnostics.some((d) => d.file.endsWith("infra.ts"))).toBe(true);
    expect(diagnostics.filter((d) => d.file.includes("ops"))).toEqual([]);

    expect(existsSync(ranPath), "the script was imported").toBe(false);
  }, TIMEOUT);

  test("an `exclude` glob keeps list and explain out of the script", async () => {
    await writeConfig(', exclude: ["ops/**"]');
    await writeRunner();

    for (const command of ["list", "explain"]) {
      const { status, stdout, stderr } = runCli([command, testDir]);
      expect(stderr, command).not.toContain("no op named");
      expect(status, command).toBe(0);
      expect(stdout, command).toContain("ns");
    }

    expect(existsSync(ranPath), "the script was imported").toBe(false);
  }, TIMEOUT);

  test("the skip marker keeps build and lint out of the script with no config change", async () => {
    await writeConfig("");
    await writeRunner(`// ${SKIP_MARKER}: a runner, not a declaration`);

    const build = runCli(["build", testDir]);
    expect(build.stderr).not.toContain("no op named");
    expect(build.status).toBe(0);

    const lint = runCli(["lint", testDir, "--format", "json"]);
    expect(lint.status).toBe(0);
    const diagnostics = JSON.parse(lint.stdout) as Array<{ file: string }>;
    expect(diagnostics.filter((d) => d.file.includes("ops"))).toEqual([]);

    expect(existsSync(ranPath), "the script was imported").toBe(false);
  }, TIMEOUT);

  test("the control: without exclude, `chant lint` lints the script", async () => {
    await writeConfig("");
    await writeRunner();

    const lint = runCli(["lint", testDir, "--format", "json"]);
    const diagnostics = JSON.parse(lint.stdout) as Array<{ file: string; ruleId: string }>;
    expect(diagnostics.some((d) => d.file.endsWith(join("ops", "run.ts")) && d.ruleId === "EVL003")).toBe(true);
  }, TIMEOUT);
});
