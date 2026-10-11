import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdir, writeFile, rm, symlink, realpath } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

/**
 * chant #1045 Phase 2 (post-merge finding) — regression test for a real
 * bypass: `resolveProjectLexicons` (`./plugins.ts`) used to fall back to a
 * full, unsandboxed `discover()` call whenever a project's `chant.config.ts`
 * didn't list `lexicons` explicitly — importing and RUNNING every source
 * file in the CLI's own process, with no `--fold`/`--sandbox` involved at
 * all, before the caller's own (possibly folded, possibly sandboxed)
 * discovery ever ran. `resolveProjectLexicons` sits underneath nearly every
 * CLI command (`build`, `lint`, `doctor`, `import`, `graph`, the MCP server),
 * so this reached far past `chant build --fold`.
 *
 * This is deliberately an end-to-end test of the real CLI entry point
 * (`main.ts`, spawned as a genuine child process — the same way `bin/chant`
 * invokes it), NOT a call to `build()`/`buildCommand()` directly: calling
 * either of those skips the exact code path the bug lived in
 * (`main.ts`'s `loadPluginsOrExit` → `resolveProjectLexicons`), which is
 * precisely how the corpus differential and Phase 2's other tests — all of
 * which call `build()` — passed while this stayed open.
 *
 * Fixture lives in a fresh tmpdir per test, never in the source tree.
 */

const thisDir = dirname(fileURLToPath(import.meta.url));
const mainTsPath = resolve(thisDir, "main.ts");
const repoRoot = resolve(thisDir, "../../../..");

describe("CLI end-to-end — resolveProjectLexicons must not execute project source", () => {
  let testDir: string;
  let exfilMarkerPath: string;

  beforeEach(async () => {
    testDir = await realpath(
      await (async () => {
        const dir = join(tmpdir(), `chant-security-boundary-test-${Date.now()}-${Math.random()}`);
        await mkdir(join(dir, "src"), { recursive: true });
        return dir;
      })(),
    );
    exfilMarkerPath = join(testDir, "exfil-happened.txt");

    // A real `node_modules/@intentius/chant-lexicon-k8s` symlink — same shape
    // this monorepo's own workspace linking produces — so the fixture's bare
    // `from "@intentius/chant-lexicon-k8s"` import resolves exactly the way a
    // real installed project's would, and `detectLexicons`'s text scan (which
    // matches that literal specifier) has something genuine to find.
    await mkdir(join(testDir, "node_modules", "@intentius"), { recursive: true });
    await symlink(
      join(repoRoot, "lexicons", "k8s"),
      join(testDir, "node_modules", "@intentius", "chant-lexicon-k8s"),
      "dir",
    );

    // No `lexicons` field — the exact condition that sends
    // `resolveProjectLexicons` down the detection fallback.
    await writeFile(join(testDir, "chant.config.ts"), "export default {};\n");

    // A hostile source file: reads a file outside the project and the
    // ambient environment at module top level (before its one Declarable
    // export), and — if it got to run — writes a marker file so the test can
    // tell "executed" apart from "folded" without depending on stdout
    // capture alone.
    await writeFile(
      join(testDir, "src", "infra.ts"),
      [
        'import { readFileSync, writeFileSync } from "node:fs";',
        'import { Namespace } from "@intentius/chant-lexicon-k8s";',
        "",
        "const stolen = readFileSync(\"/etc/hosts\", \"utf-8\");",
        `writeFileSync(${JSON.stringify(exfilMarkerPath)}, "exfil: " + stolen.slice(0, 20) + " env=" + Object.keys(process.env).length);`,
        'console.error(">>> EXFIL " + stolen.slice(0, 20) + " env=" + Object.keys(process.env).length);',
        "",
        'export const ns = new Namespace({ metadata: { name: "x" } });',
        "",
      ].join("\n"),
    );
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  /** Spawn the real CLI (`main.ts`, exactly as `bin/chant` invokes it via `npx tsx`) and capture its output. */
  function runCli(args: string[]): { status: number | null; stdout: string; stderr: string } {
    const result = spawnSync("npx", ["tsx", mainTsPath, ...args], {
      cwd: repoRoot,
      encoding: "utf-8",
      timeout: 30_000,
      env: { ...process.env, CHANT_SECRET_FOR_TEST: "should-never-leak" },
    });
    return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  }

  test("`chant build --fold` on a project with no `lexicons` config does not execute the hostile file", () => {
    // --verbose: the per-file fold decision lines are behind it (#1424).
    const { status, stdout, stderr } = runCli(["build", testDir, "--fold", "--verbose"]);

    expect(stderr).not.toMatch(/EXFIL/);
    expect(stdout).not.toMatch(/EXFIL/);
    expect(existsSync(exfilMarkerPath), "hostile file wrote its marker — it executed").toBe(false);

    // The build still has to actually work — this isn't proving safety by
    // making the build fail outright.
    expect(status).toBe(0);
    expect(stdout).toContain("kind: Namespace");

    // The fold decision for the hostile file should say what's now true:
    // this file really did fold with zero module execution.
    expect(stderr).toMatch(/\[fold:fold\] src\/infra\.ts/);
  });

  test("`chant build --fold --sandbox` also does not execute the hostile file (both layers closed)", () => {
    const { status, stdout, stderr } = runCli(["build", testDir, "--fold", "--sandbox"]);

    expect(stderr).not.toMatch(/EXFIL/);
    expect(stdout).not.toMatch(/EXFIL/);
    expect(existsSync(exfilMarkerPath)).toBe(false);
    expect(status).toBe(0);
    expect(stdout).toContain("kind: Namespace");
  });

  test("`chant lint` (which also resolves lexicons this way) does not execute the hostile file", () => {
    const { stdout, stderr } = runCli(["lint", testDir]);

    expect(stderr).not.toMatch(/EXFIL/);
    expect(stdout).not.toMatch(/EXFIL/);
    expect(existsSync(exfilMarkerPath), "hostile file wrote its marker — it executed").toBe(false);
  });
});
