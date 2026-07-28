import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadChantConfig } from "../../config";
import {
  armSandboxConfigEvaluation,
  evaluateProjectConfigSync,
  isSandboxConfigEvaluationArmed,
  resetSandboxConfigEvaluationForTests,
} from "../../config-sandbox";
import { ENV_VAR } from "../../env";

/**
 * chant #1113 — `chant.config.ts` is project-authored code, and under
 * `--sandbox` it must not execute in the CLI's process.
 *
 * Same shape of proof as `./fold-boundary.test.ts` (chant #1093): the fixture
 * config sets a `globalThis` marker at module top level, and a marker set
 * inside the sandboxed child cannot reach this process. Every pair asserts the
 * UNARMED half fires the marker first, so the probe is proven capable of
 * failing before the armed half asserts it stays clean.
 *
 * Fixtures go to a fresh tmpdir per test — never the source tree — so no two
 * tests share a module path and nothing bleeds through Node's module cache.
 */

const MARKER = "__chant1113ConfigEvaluated";

type MarkerHost = Record<string, boolean | undefined>;

function marker(): boolean | undefined {
  return (globalThis as unknown as MarkerHost)[MARKER];
}

describe("chant.config.ts evaluation under --sandbox (chant #1113)", () => {
  let testDir: string;
  let savedEnv: string | undefined;

  beforeEach(async () => {
    const dir = join(tmpdir(), `chant-1113-config-${Date.now()}-${Math.random()}`);
    await mkdir(dir, { recursive: true });
    testDir = await realpath(dir);
    delete (globalThis as unknown as MarkerHost)[MARKER];
    savedEnv = process.env[ENV_VAR];
    resetSandboxConfigEvaluationForTests();
  });

  afterEach(async () => {
    delete (globalThis as unknown as MarkerHost)[MARKER];
    if (savedEnv === undefined) delete process.env[ENV_VAR];
    else process.env[ENV_VAR] = savedEnv;
    resetSandboxConfigEvaluationForTests();
    await rm(testDir, { recursive: true, force: true });
  });

  /** A config that announces its own evaluation, the way any project file's top level can. */
  async function writeMarkerConfig(body = `{ lexicons: ["aws"], ownership: { stack: "s" } }`): Promise<void> {
    await writeFile(
      join(testDir, "chant.config.ts"),
      `globalThis[${JSON.stringify(MARKER)}] = true;\nexport default ${body};\n`,
    );
  }

  test("without --sandbox the config DOES evaluate in this process (the probe fires)", async () => {
    await writeMarkerConfig();

    const { config } = await loadChantConfig(testDir);

    expect(isSandboxConfigEvaluationArmed()).toBe(false);
    expect(marker(), "the config's top level ran in this process").toBe(true);
    expect(config.lexicons).toEqual(["aws"]);
    expect(config.ownership).toEqual({ stack: "s" });
  });

  test("armed, the same config evaluates in the child: no marker here, same config", async () => {
    await writeMarkerConfig();
    armSandboxConfigEvaluation();

    const { config, configPath } = await loadChantConfig(testDir);

    expect(marker(), "the config's top level must NOT run in the CLI process").toBeUndefined();
    expect(configPath).toBe(join(testDir, "chant.config.ts"));
    expect(config.lexicons).toEqual(["aws"]);
    expect(config.ownership).toEqual({ stack: "s" });
  });

  test("a config authored as a named `config` export crosses the same way", async () => {
    await writeFile(
      join(testDir, "chant.config.ts"),
      `globalThis[${JSON.stringify(MARKER)}] = true;\nexport const config = { lexicons: ["k8s"] };\n`,
    );
    armSandboxConfigEvaluation();

    const { config } = await loadChantConfig(testDir);

    expect(marker()).toBeUndefined();
    expect(config.lexicons).toEqual(["k8s"]);
  });

  test("nested data — buildParams, stacks, lint rules — survives the round trip", async () => {
    await writeMarkerConfig(
      `{
         lexicons: ["aws"],
         stacks: [{ name: "net", src: "src/net" }, { name: "app", src: "src/app" }],
         buildParams: { tier: { type: "string", default: "light", enum: ["light", "prod"] } },
         lint: { rules: { COR001: "error", COR002: ["warning", { max: 3 }] }, policies: ["policies/org.ts"] },
       }`,
    );
    armSandboxConfigEvaluation();

    const { config } = await loadChantConfig(testDir);

    expect(marker()).toBeUndefined();
    expect(config.stacks).toEqual([
      { name: "net", src: "src/net" },
      { name: "app", src: "src/app" },
    ]);
    expect(config.buildParams).toEqual({
      tier: { type: "string", default: "light", enum: ["light", "prod"] },
    });
    expect(config.lint?.rules).toEqual({ COR001: "error", COR002: ["warning", { max: 3 }] });
    expect(config.lint?.policies).toEqual(["policies/org.ts"]);
  });

  test("chant.config.json needs no child — it is data, parsed in-process either way", async () => {
    await writeFile(
      join(testDir, "chant.config.json"),
      JSON.stringify({ lexicons: ["gcp"], build: { sandbox: true } }),
    );
    armSandboxConfigEvaluation();

    const { config, configPath } = await loadChantConfig(testDir);

    expect(configPath).toBe(join(testDir, "chant.config.json"));
    expect(config.lexicons).toEqual(["gcp"]);
  });

  test("a value that cannot cross as JSON is refused, naming the key", async () => {
    await writeFile(
      join(testDir, "chant.config.ts"),
      `export default { lexicons: ["aws"], hooks: { beforeBuild: () => 1 } };\n`,
    );
    armSandboxConfigEvaluation();

    await expect(loadChantConfig(testDir)).rejects.toThrow(/hooks\.beforeBuild: a function/);
    expect(marker()).toBeUndefined();
  });

  test("a Date is refused too — JSON.stringify would silently turn it into a string", async () => {
    await writeFile(
      join(testDir, "chant.config.ts"),
      `export default { lexicons: ["aws"], meta: { generatedAt: new Date(0) } };\n`,
    );
    armSandboxConfigEvaluation();

    await expect(loadChantConfig(testDir)).rejects.toThrow(/meta\.generatedAt: a Date/);
  });

  test("a config that reads outside the project is denied, naming the config file", async () => {
    await writeFile(
      join(testDir, "chant.config.ts"),
      `import { readFileSync } from "node:fs";\n` +
        `const stolen = readFileSync("/etc/hosts", "utf-8");\n` +
        `export default { lexicons: [stolen.slice(0, 3)] };\n`,
    );
    armSandboxConfigEvaluation();

    await expect(loadChantConfig(testDir)).rejects.toThrow(/sandbox denied FileSystemRead/);
  });

  test("a config that tries to spawn a process is denied", async () => {
    await writeFile(
      join(testDir, "chant.config.ts"),
      `import { execSync } from "node:child_process";\n` +
        `execSync("echo pwned");\n` +
        `export default { lexicons: ["aws"] };\n`,
    );
    armSandboxConfigEvaluation();

    await expect(loadChantConfig(testDir)).rejects.toThrow(/sandbox denied/);
  });

  test("the child's environment is scrubbed — but --env still reaches the config", async () => {
    process.env[ENV_VAR] = "prod";
    process.env.CHANT_1113_SECRET = "hunter2";
    try {
      await writeFile(
        join(testDir, "chant.config.ts"),
        `export default {\n` +
          `  environments: [process.env[${JSON.stringify(ENV_VAR)}] ?? "none"],\n` +
          `  sourceDir: process.env.CHANT_1113_SECRET ?? "scrubbed",\n` +
          `};\n`,
      );
      armSandboxConfigEvaluation();

      const { config } = await loadChantConfig(testDir);

      expect(config.environments, "--env is forwarded so the config resolves the same either way").toEqual(["prod"]);
      expect(config.sourceDir, "nothing else from the CLI's environment is visible").toBe("scrubbed");
    } finally {
      delete process.env.CHANT_1113_SECRET;
    }
  });

  test("an armed load is memoized, so repeated loads cost one child, not one each", async () => {
    await writeMarkerConfig();
    armSandboxConfigEvaluation();

    const first = await loadChantConfig(testDir);
    const second = await loadChantConfig(testDir);

    expect(second.config).toBe(first.config);
    expect(marker()).toBeUndefined();
  });

  test("the sync lint loader reuses that result rather than requiring the file", async () => {
    await writeMarkerConfig(`{ lexicons: ["aws"], lint: { rules: { COR001: "warning" } } }`);
    armSandboxConfigEvaluation();

    await loadChantConfig(testDir);
    const config = evaluateProjectConfigSync(join(testDir, "chant.config.ts"), testDir) as {
      lint?: { rules?: Record<string, unknown> };
    };

    expect(config.lint?.rules?.COR001).toBe("warning");
    expect(marker()).toBeUndefined();
  });

  test("the sync lint loader refuses rather than importing when nothing was evaluated yet", async () => {
    await writeMarkerConfig();
    armSandboxConfigEvaluation();

    expect(() => evaluateProjectConfigSync(join(testDir, "chant.config.ts"), testDir)).toThrow(
      /Cannot read .* synchronously under --sandbox/,
    );
    expect(marker()).toBeUndefined();
  });

  /**
   * chant #1148 — `chant.config.ts`'s own `console.log`/`console.error` used
   * to go nowhere under `--sandbox`. Same relay as the run-fallback child
   * (`./run.test.ts`), just this child's own prefix.
   */
  describe("console output forwarding (chant #1148)", () => {
    beforeEach(() => {
      vi.restoreAllMocks();
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    /** Spies on `process.stderr.write` and returns the lines captured so far — same shape as `../../cli/handlers/emulator.test.ts`'s `stdout()`/`stderr()` helpers. */
    function captureStderr(): string[] {
      const lines: string[] = [];
      vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
        lines.push(String(chunk));
        return true;
      });
      return lines;
    }

    // See ./run.test.ts's identical helper doc: the IPC "message" the awaited
    // call resolves on and the child's stdout/stderr pipe data are
    // independent channels, so polling briefly avoids a flaky assertion.
    async function waitFor(lines: string[], matcher: RegExp, timeoutMs = 5000): Promise<void> {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        if (matcher.test(lines.join(""))) return;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error(`stderr never matched ${matcher}. Captured so far:\n${lines.join("")}`);
    }

    test("the config's own console.log/console.error are forwarded, prefixed with [sandbox:config]", async () => {
      const stderr = captureStderr();
      await writeFile(
        join(testDir, "chant.config.ts"),
        `console.log("hello from config stdout");\n` +
          `console.error("hello from config stderr");\n` +
          `export default { lexicons: ["aws"] };\n`,
      );
      armSandboxConfigEvaluation();

      const { config } = await loadChantConfig(testDir);

      expect(config.lexicons).toEqual(["aws"]);
      await waitFor(stderr, /^\[sandbox:config\] hello from config stdout$/m);
      await waitFor(stderr, /^\[sandbox:config\] hello from config stderr$/m);
    });
  });
});
