import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdir, writeFile, rm, realpath, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import type { Declarable } from "../../declarable";
import { createResource } from "../../runtime";
import { resolveAttrRefs } from "../resolve";
import { ENV_VAR } from "../../env";
import { loadPolicyChecks } from "../../lint/policy";
import {
  armSandboxPolicyExecution,
  isSandboxPolicyExecutionArmed,
  resetSandboxPolicyExecutionForTests,
  runProjectPolicies,
  type ProjectPolicyRun,
} from "../../lint/policy-sandbox";

/**
 * chant #1131 — a `lint.policies` module is project-authored code, and under
 * `--sandbox` neither its top level nor its `check` function may run in the
 * CLI's process.
 *
 * Same shape of proof as `./fold-boundary.test.ts` (#1093) and
 * `./config-boundary.test.ts` (#1113): the fixture policy sets a `globalThis`
 * marker at module top level and another inside `check`, and a marker set in
 * the sandboxed child cannot reach this process. **The unarmed half is asserted
 * first**, so the probe is proven capable of firing before the armed half
 * asserts it stays clean.
 *
 * Fixtures go to a fresh tmpdir per test — never the source tree — so no two
 * tests share a module path and nothing bleeds through Node's module cache.
 */

const TOP_MARKER = "__chant1131PolicyTopLevel";
const CHECK_MARKER = "__chant1131PolicyCheckRan";

type MarkerHost = Record<string, boolean | undefined>;

function marker(name: string): boolean | undefined {
  return (globalThis as unknown as MarkerHost)[name];
}

/** A small, realistic build result: two entities with a cross-reference, plus one lexicon's serialized output. */
function buildResultFixture(): ProjectPolicyRun["buildResult"] {
  const Vpc = createResource("Test::Vpc", "test", { vpcId: "VpcId" });
  const Ingress = createResource("Test::Ingress", "test", {});
  const vpc = new Vpc({ CidrBlock: "10.0.0.0/16" });
  const ingress = new Ingress({ VpcId: (vpc as unknown as Record<string, unknown>).vpcId, tls: [] });
  const entities = new Map<string, Declarable>([
    ["Vpc", vpc as unknown as Declarable],
    ["Ingress", ingress as unknown as Declarable],
  ]);
  resolveAttrRefs(entities);

  return {
    outputs: new Map<string, string>([["test", "kind: Ingress\nmetadata:\n  name: storefront\n"]]),
    entities,
    warnings: [],
    errors: [],
    sourceFileCount: 2,
  } as unknown as ProjectPolicyRun["buildResult"];
}

describe("lint.policies execution under --sandbox (chant #1131)", () => {
  let testDir: string;
  let savedEnv: string | undefined;

  beforeEach(async () => {
    const dir = join(tmpdir(), `chant-1131-policy-${Date.now()}-${Math.random()}`);
    await mkdir(dir, { recursive: true });
    testDir = await realpath(dir);
    delete (globalThis as unknown as MarkerHost)[TOP_MARKER];
    delete (globalThis as unknown as MarkerHost)[CHECK_MARKER];
    savedEnv = process.env[ENV_VAR];
    resetSandboxPolicyExecutionForTests();
  });

  afterEach(async () => {
    delete (globalThis as unknown as MarkerHost)[TOP_MARKER];
    delete (globalThis as unknown as MarkerHost)[CHECK_MARKER];
    if (savedEnv === undefined) delete process.env[ENV_VAR];
    else process.env[ENV_VAR] = savedEnv;
    resetSandboxPolicyExecutionForTests();
    await rm(testDir, { recursive: true, force: true });
  });

  /** A policy that announces its own execution twice: once at module top level, once per check call. */
  async function writeMarkerPolicy(name = "org.ts", body?: string): Promise<string> {
    await writeFile(
      join(testDir, name),
      body ??
        `globalThis[${JSON.stringify(TOP_MARKER)}] = true;\n` +
          `export const tlsRequired = {\n` +
          `  id: "ORG-TLS",\n` +
          `  description: "ingress must terminate TLS",\n` +
          `  check(ctx) {\n` +
          `    globalThis[${JSON.stringify(CHECK_MARKER)}] = true;\n` +
          `    const out = [];\n` +
          `    for (const [entityName, entity] of ctx.entities) {\n` +
          `      const tls = entity.props && entity.props.tls;\n` +
          `      if (Array.isArray(tls) && tls.length === 0) {\n` +
          `        out.push({ checkId: "ORG-TLS", severity: "error", message: entityName + " has no TLS in " + ctx.env, entity: entityName });\n` +
          `      }\n` +
          `    }\n` +
          `    if (ctx.outputs.get("test").includes("storefront")) {\n` +
          `      out.push({ checkId: "ORG-TLS", severity: "warning", message: "saw storefront in the output" });\n` +
          `    }\n` +
          `    return out;\n` +
          `  },\n` +
          `};\n`,
    );
    return name;
  }

  function run(policies: string[], env = "prod"): ReturnType<typeof runProjectPolicies> {
    return runProjectPolicies({ policies, configDir: testDir, buildResult: buildResultFixture(), env });
  }

  test("without --sandbox the policy DOES run in this process (both probes fire)", async () => {
    await writeMarkerPolicy();

    const diags = await run(["org.ts"]);

    expect(isSandboxPolicyExecutionArmed()).toBe(false);
    expect(marker(TOP_MARKER), "the policy module's top level ran in this process").toBe(true);
    expect(marker(CHECK_MARKER), "the check function ran in this process").toBe(true);
    expect(diags).toEqual([
      { checkId: "ORG-TLS", severity: "error", message: "Ingress has no TLS in prod", entity: "Ingress" },
      { checkId: "ORG-TLS", severity: "warning", message: "saw storefront in the output" },
    ]);
  });

  test("armed, the same policy runs in the child: no markers here, IDENTICAL diagnostics", async () => {
    await writeMarkerPolicy();
    const plain = await run(["org.ts"]);

    delete (globalThis as unknown as MarkerHost)[TOP_MARKER];
    delete (globalThis as unknown as MarkerHost)[CHECK_MARKER];
    armSandboxPolicyExecution();
    const sandboxed = await run(["org.ts"]);

    expect(marker(TOP_MARKER), "the policy module's top level must NOT run in the CLI process").toBeUndefined();
    expect(marker(CHECK_MARKER), "the check function must NOT run in the CLI process").toBeUndefined();
    expect(sandboxed).toEqual(plain);
  });

  test("several policy modules keep their declaration order across the boundary", async () => {
    for (const [file, id] of [
      ["a.ts", "A"],
      ["b.ts", "B"],
    ] as const) {
      await writeFile(
        join(testDir, file),
        `export const c = { id: ${JSON.stringify(id)}, description: "d", check: () => [{ checkId: ${JSON.stringify(id)}, severity: "info", message: "m" }] };\n`,
      );
    }

    const plain = await run(["a.ts", "b.ts"]);
    armSandboxPolicyExecution();
    const sandboxed = await run(["a.ts", "b.ts"]);

    expect(plain.map((d) => d.checkId)).toEqual(["A", "B"]);
    expect(sandboxed).toEqual(plain);
  });

  test("a policy that reads outside the project is denied, naming the policy file", async () => {
    await writeMarkerPolicy(
      "org.ts",
      `import { readFileSync } from "node:fs";\n` +
        `const stolen = readFileSync("/etc/hosts", "utf-8");\n` +
        `export const c = { id: "X", description: "d", check: () => [{ checkId: "X", severity: "info", message: stolen.slice(0, 3) }] };\n`,
    );
    armSandboxPolicyExecution();

    await expect(run(["org.ts"])).rejects.toThrow(/sandbox denied FileSystemRead \(\/etc\/hosts\)/);
    await expect(run(["org.ts"])).rejects.toThrow(/org\.ts/);
  });

  test("a policy that writes a file is denied — the boundary costs this pattern, deliberately", async () => {
    // A policy that drops a compliance report next to the build is a plausible
    // thing to have written. Under `--sandbox` it fails, loudly, rather than
    // succeeding and making the flag a lie.
    await writeMarkerPolicy(
      "org.ts",
      `import { writeFileSync } from "node:fs";\n` +
        `export const c = { id: "X", description: "d", check: () => { writeFileSync(${JSON.stringify(join(testDir, "report.json"))}, "{}"); return []; } };\n`,
    );
    armSandboxPolicyExecution();

    await expect(run(["org.ts"])).rejects.toThrow(/sandbox denied FileSystemWrite/);
    await expect(readFile(join(testDir, "report.json"))).rejects.toThrow();
  });

  test("a policy that tries to spawn a process is denied", async () => {
    await writeMarkerPolicy(
      "org.ts",
      `import { execSync } from "node:child_process";\n` +
        `export const c = { id: "X", description: "d", check: () => { execSync("echo pwned"); return []; } };\n`,
    );
    armSandboxPolicyExecution();

    await expect(run(["org.ts"])).rejects.toThrow(/sandbox denied/);
  });

  test("the child's environment is scrubbed — but --env still reaches a policy", async () => {
    process.env[ENV_VAR] = "prod";
    process.env.CHANT_1131_SECRET = "hunter2";
    try {
      await writeMarkerPolicy(
        "org.ts",
        `export const c = {\n` +
          `  id: "ENV", description: "d",\n` +
          `  check: (ctx) => [\n` +
          `    { checkId: "ENV", severity: "info", message: "ctx.env=" + ctx.env },\n` +
          `    { checkId: "ENV", severity: "info", message: "CHANT_ENV=" + (process.env[${JSON.stringify(ENV_VAR)}] ?? "unset") },\n` +
          `    { checkId: "ENV", severity: "info", message: "secret=" + (process.env.CHANT_1131_SECRET ?? "scrubbed") },\n` +
          `  ],\n` +
          `};\n`,
      );
      armSandboxPolicyExecution();

      const diags = await run(["org.ts"], "prod");

      expect(diags.map((d) => d.message)).toEqual(["ctx.env=prod", "CHANT_ENV=prod", "secret=scrubbed"]);
    } finally {
      delete process.env.CHANT_1131_SECRET;
    }
  });

  test("a diagnostic that is not data is refused, naming the policy module and the key path", async () => {
    await writeMarkerPolicy(
      "org.ts",
      `export const c = { id: "X", description: "d", check: () => [{ checkId: "X", severity: "error", message: "m", fix: () => 1 }] };\n`,
    );
    armSandboxPolicyExecution();

    const promise = run(["org.ts"]);
    await expect(promise).rejects.toThrow(/org\.ts \[0\]\.fix: a function/);
    await expect(run(["org.ts"])).rejects.toThrow(/Cannot run lint\.policies inside the --sandbox boundary/);
  });

  test("a diagnostic with a bad severity is refused rather than printed as one", async () => {
    await writeMarkerPolicy(
      "org.ts",
      `export const c = { id: "X", description: "d", check: () => [{ checkId: "X", severity: "fatal", message: "m" }] };\n`,
    );
    armSandboxPolicyExecution();

    await expect(run(["org.ts"])).rejects.toThrow(/severity: not one of "error", "warning", "info"/);
  });

  test("a policy module that throws at import fails naming the file", async () => {
    await writeMarkerPolicy("org.ts", `throw new Error("policy exploded");\n`);
    armSandboxPolicyExecution();

    await expect(run(["org.ts"])).rejects.toThrow(/policy exploded/);
  });

  test("a check that throws fails the build rather than silently producing nothing", async () => {
    await writeMarkerPolicy(
      "org.ts",
      `export const c = { id: "X", description: "d", check: () => { throw new Error("check exploded"); } };\n`,
    );
    armSandboxPolicyExecution();

    await expect(run(["org.ts"])).rejects.toThrow(/check exploded/);
  });

  test("armed, loadPolicyChecks refuses rather than importing project code here", async () => {
    await writeMarkerPolicy();
    armSandboxPolicyExecution();

    await expect(loadPolicyChecks(["org.ts"], testDir)).rejects.toThrow(/Cannot load lint\.policies .* under --sandbox/);
    expect(marker(TOP_MARKER)).toBeUndefined();
  });

  test("no policies declared means no child at all", async () => {
    armSandboxPolicyExecution();

    expect(await run([])).toEqual([]);
  });

  /**
   * chant #1148 — a policy's own `console.log`/`console.error` used to go
   * nowhere under `--sandbox` (noted as a residual when #1131 shipped). Same
   * relay as the run-fallback and config children, keyed to the policy
   * module's own basename rather than a generic tag.
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

    // See ./run.test.ts's identical helper doc: the IPC "message" the
    // awaited call resolves on and the child's stdout/stderr pipe data are
    // independent channels, so polling briefly avoids a flaky assertion.
    async function waitFor(lines: string[], matcher: RegExp, timeoutMs = 5000): Promise<void> {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        if (matcher.test(lines.join(""))) return;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error(`stderr never matched ${matcher}. Captured so far:\n${lines.join("")}`);
    }

    test("a policy's console.log/console.error are forwarded, prefixed with [policy:<module-basename>]", async () => {
      const stderr = captureStderr();
      await writeMarkerPolicy(
        "org.ts",
        `console.log("hello from policy stdout");\n` +
          `console.error("hello from policy stderr");\n` +
          `export const c = { id: "X", description: "d", check: () => [] };\n`,
      );
      armSandboxPolicyExecution();

      const diags = await run(["org.ts"]);

      expect(diags).toEqual([]);
      await waitFor(stderr, /^\[policy:org\.ts\] hello from policy stdout$/m);
      await waitFor(stderr, /^\[policy:org\.ts\] hello from policy stderr$/m);
    });
  });

  test("a program that runs a policy child EXITS — the child is not left holding the event loop", async () => {
    // Found the hard way while measuring #1131's cost: unlike the run and
    // config drivers, the policy driver keeps a `message` listener registered
    // in order to RECEIVE its input, and a `message` listener refs the IPC
    // channel — so the child stayed alive after answering, and its live channel
    // kept the parent alive too. `chant build` hid it (`cli/main.ts` ends in
    // `process.exit`); anything embedding chant as a library hung forever.
    //
    // Asserted the only way that actually proves it: run a real program in a
    // real process and require it to exit on its own.
    await writeFile(
      join(testDir, "org.ts"),
      `export const c = { id: "X", description: "d", check: () => [] };\n`,
    );
    const script = join(testDir, "driver.mts");
    await writeFile(
      script,
      `import { runPoliciesSandboxed } from ${JSON.stringify(join(import.meta.dirname, "policy-run.ts"))};\n` +
        `await runPoliciesSandboxed({\n` +
        `  policyPaths: [${JSON.stringify(join(testDir, "org.ts"))}],\n` +
        `  buildResult: { outputs: new Map(), entities: new Map(), warnings: [], errors: [], sourceFileCount: 0 },\n` +
        `  projectRoot: ${JSON.stringify(testDir)},\n` +
        `});\n` +
        `console.log("done");\n`,
    );

    const exited = await new Promise<{ code: number | null; timedOut: boolean }>((resolvePromise) => {
      const child = spawn(process.execPath, ["--import", "tsx", script], { stdio: "ignore" });
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolvePromise({ code: null, timedOut: true });
      }, 60_000);
      child.on("exit", (code) => {
        clearTimeout(timer);
        resolvePromise({ code, timedOut: false });
      });
    });

    expect(exited.timedOut, "the process did not exit — a sandbox child is holding the event loop open").toBe(false);
    expect(exited.code).toBe(0);
  });
});
