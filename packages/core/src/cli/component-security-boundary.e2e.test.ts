import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

/**
 * chant #1051 — regression test for `discoverComponents`'s exposure:
 * `packages/core/src/components/discover.ts` used to `await import()` every
 * `*.component.ts` file unconditionally, in the CLI's own process, with no
 * `--fold`/`--sandbox` equivalent at all — the same class of bug #1045 fixed
 * for lexicon-resource discovery, but for the parallel `*.component.ts`
 * convention (`chant list --components`, `chant describe --components`,
 * `chant graph --components`, `chant build --components --generate`, `chant
 * run --components`, `chant lint`'s COMP* checks, `chant lifecycle
 * diff/plan --live`).
 *
 * Deliberately an end-to-end test of the real CLI entry point (`main.ts`,
 * spawned as a genuine child process — the same way `bin/chant` invokes it),
 * NOT a call to `discoverComponents()`/`listComponents()` directly: calling
 * either of those skips the exact thing this test exists to prove — that the
 * `--sandbox` flag is actually wired from `chant`'s argv, through `main.ts`,
 * into the CLI handler, into `discoverComponents`'s `sandbox` option. This
 * mirrors `./security-boundary.test.ts`'s rationale (the #1045 Phase 2 bypass
 * was caught precisely because a differential calling `build()` directly
 * couldn't see a hole in the CLI layer above it).
 *
 * Evidence is routed through `chant list --components`'s own JSON stdout (a
 * component NAME), never stderr and never a bare "did it print EXFIL" check —
 * a suppressed/swallowed console message from the sandboxed child can't fake
 * this: the hostile fixture always exports a syntactically valid `Component`
 * (wrapping every privileged attempt in try/catch, so discovery never simply
 * errors out) whose `name` field encodes exactly what it managed to do:
 * "OK" for each of read/write/spawn that succeeded, or the Permission
 * Model's real `err.code` when denied, plus the ambient env var count —
 * mirroring how the #1045 PR itself was verified ("unsandboxed produced
 * read-u-env77, sandboxed produced blocked-erraccessdenied-env2").
 */

const thisDir = dirname(fileURLToPath(import.meta.url));
const mainTsPath = resolve(thisDir, "main.ts");
const repoRoot = resolve(thisDir, "../../../..");

describe("CLI end-to-end — discoverComponents must not execute *.component.ts unsandboxed when --sandbox is passed", () => {
  let testDir: string;
  let escapedMarkerPath: string;

  beforeEach(async () => {
    testDir = await realpath(
      await (async () => {
        const dir = join(tmpdir(), `chant-component-security-boundary-test-${Date.now()}-${Math.random()}`);
        await mkdir(dir, { recursive: true });
        return dir;
      })(),
    );
    // Outside the project directory chant scans — the sandbox's
    // `--allow-fs-write` allowance (there isn't one) and `--allow-fs-read`
    // scope (project dir + bundle dir only) must both reject this.
    escapedMarkerPath = join(testDir, "..", `chant-component-escaped-${Date.now()}.txt`);

    await writeFile(join(testDir, "chant.config.ts"), "export default {};\n");

    // A hostile component file: attempts a filesystem read outside the
    // project, a filesystem write outside the project, and a child-process
    // spawn, all at module top level (before its one real Component export),
    // wrapping each attempt so a permission denial never throws discovery
    // into "import error" — every signal is folded into the component's own
    // `name`, which is what `chant list --components --format json` prints
    // to STDOUT, so suppressed child stderr/console output cannot fake a
    // pass here.
    await writeFile(
      join(testDir, "evil.component.ts"),
      [
        'import { readFileSync, writeFileSync } from "node:fs";',
        'import { execSync } from "node:child_process";',
        "",
        "function attempt(label, fn) {",
        "  try {",
        "    fn();",
        '    return label + "OK";',
        "  } catch (err) {",
        '    const code = err && err.code ? String(err.code).replace(/[^A-Za-z0-9]/g, "") : "ERR";',
        "    return label + code;",
        "  }",
        "}",
        "",
        `const readTag = attempt("read", () => { readFileSync("/etc/hosts", "utf-8"); });`,
        `const writeTag = attempt("write", () => { writeFileSync(${JSON.stringify(escapedMarkerPath)}, "pwned"); });`,
        `const spawnTag = attempt("spawn", () => { execSync("true"); });`,
        "const envCount = Object.keys(process.env).length;",
        "",
        "export const probe = {",
        "  name: `probe-${readTag}-${writeTag}-${spawnTag}-env${envCount}`,",
        "  dependsOn: [],",
        '  deploy: [{ phase: "Apply", steps: [{ kind: "shell", command: "echo ok" }] }],',
        "};",
        "",
      ].join("\n"),
    );
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
    await rm(escapedMarkerPath, { force: true });
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

  /** Pull the discovered component's `name` field out of `chant list --components --format json`'s stdout. */
  function probeNameFrom(stdout: string): string {
    const parsed = JSON.parse(stdout) as Array<{ name: string }>;
    const found = parsed.find((c) => c.name.startsWith("probe-"));
    expect(found, `expected a "probe-*" component in stdout: ${stdout}`).toBeDefined();
    return found!.name;
  }

  test("without --sandbox, the hostile *.component.ts file executes fully (establishes the fixture is genuinely hostile)", () => {
    const { status, stdout } = runCli(["list", testDir, "--components", "--format", "json"]);
    expect(status).toBe(0);

    const name = probeNameFrom(stdout);
    expect(name).toMatch(/^probe-readOK-writeOK-spawnOK-env\d+$/);

    // A real env var count, not the sandbox's scrubbed-to-just-PATH count.
    const envCount = Number(name.match(/env(\d+)$/)![1]);
    expect(envCount).toBeGreaterThan(2);

    expect(existsSync(escapedMarkerPath), "hostile file's write should have landed unsandboxed").toBe(true);
  });

  test("with --sandbox, the hostile *.component.ts file is denied filesystem read/write, process spawn, and sees a scrubbed environment", () => {
    const { status, stdout } = runCli(["list", testDir, "--components", "--format", "json", "--sandbox"]);
    expect(status).toBe(0);

    const name = probeNameFrom(stdout);
    expect(name).toMatch(/^probe-readERRACCESSDENIED-writeERRACCESSDENIED-spawnERRACCESSDENIED-env\d+$/);

    // Only PATH (deliberately kept, see `./sandbox/run.ts`) plus whatever the
    // OS itself injects into every child regardless of the `env` passed to
    // `fork()` (macOS adds `__CF_USER_TEXT_ENCODING`) survive the spawn-time
    // env scrub — a small constant, nowhere near the ambient environment's
    // real size. Mirrors the #1045 PR's own reported number for this exact
    // shape of check ("blocked-erraccessdenied-env2").
    const envCount = Number(name.match(/env(\d+)$/)![1]);
    expect(envCount).toBeLessThanOrEqual(2);

    expect(existsSync(escapedMarkerPath), "sandboxed write must not have landed").toBe(false);
  });

  test("`chant lint --sandbox` (COMP* checks) also does not let the hostile file's write land", () => {
    const { status } = runCli(["lint", testDir, "--sandbox", "--format", "json"]);
    // Not asserting on exit code (COMP* rules may or may not flag this
    // fixture) — the write escaping the sandbox is the actual property
    // under test, matching how `./security-boundary.test.ts` treats `chant
    // lint`'s coverage of the same discovery path.
    expect(status === 0 || status === 1).toBe(true);
    expect(existsSync(escapedMarkerPath)).toBe(false);
  });
});
