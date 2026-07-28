import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { runFallbackFilesSandboxed } from "./run";

const thisDir = dirname(fileURLToPath(import.meta.url));
/** Absolute path to `packages/core/src/runtime.ts` — the real `createResource`
 * factory, imported by the cross-file fixture below exactly as a lexicon
 * package would be imported by real chant source. */
const runtimePath = resolve(thisDir, "../../runtime");

/**
 * chant #1045 Phase 2 — proves the actual isolation properties (not just
 * byte-identical output, which `examples/sandbox-differential.test.ts`
 * already covers): a run-fallback file cannot read outside the project
 * directory, write anywhere, spawn a process, or read the ambient
 * environment, and a permission denial names the file and the operation
 * rather than leaking a raw `ERR_ACCESS_DENIED`.
 *
 * Fixtures are written to a fresh tmpdir per test, never into the source
 * tree — a real chant convention here (never write test fixtures into the
 * source tree), doubly so for this module, whose whole point is running
 * untrusted-shaped project source.
 */
describe("runFallbackFilesSandboxed — isolation", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await realpath(
      await (async () => {
        const dir = join(tmpdir(), `chant-sandbox-run-test-${Date.now()}-${Math.random()}`);
        await mkdir(dir, { recursive: true });
        return dir;
      })(),
    );
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  test("denies filesystem reads outside the project directory, naming the file and the operation", async () => {
    const file = join(testDir, "evil.ts");
    await writeFile(
      file,
      `
        import { readFileSync } from "node:fs";
        readFileSync("/etc/hosts", "utf-8");
        export const value = "unreachable";
      `,
    );

    const result = await runFallbackFilesSandboxed([file], testDir);

    expect(result.entities.size).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].file).toBe(file);
    expect(result.errors[0].type).toBe("permission");
    expect(result.errors[0].message).toMatch(/FileSystemRead/);
    expect(result.errors[0].message).toContain(file);
  });

  test("denies filesystem writes anywhere", async () => {
    const file = join(testDir, "evil.ts");
    const targetPath = join(testDir, "..", "escaped.txt");
    await writeFile(
      file,
      `
        import { writeFileSync } from "node:fs";
        writeFileSync(${JSON.stringify(targetPath)}, "pwned");
        export const value = "unreachable";
      `,
    );

    const result = await runFallbackFilesSandboxed([file], testDir);

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].type).toBe("permission");
    expect(result.errors[0].message).toMatch(/FileSystemWrite/);
    expect(existsSync(targetPath)).toBe(false);
  });

  test("denies spawning a child process", async () => {
    const file = join(testDir, "evil.ts");
    const markerPath = join(testDir, "spawned.txt");
    await writeFile(
      file,
      `
        import { execSync } from "node:child_process";
        execSync(${JSON.stringify(`touch ${markerPath}`)});
        export const value = "unreachable";
      `,
    );

    const result = await runFallbackFilesSandboxed([file], testDir);

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].type).toBe("permission");
    expect(result.errors[0].message).toMatch(/ChildProcess/);
    expect(existsSync(markerPath)).toBe(false);
  });

  test("scrubs the ambient environment — a real secret set on the parent's process.env is invisible to project source", async () => {
    const file = join(testDir, "evil.ts");
    await writeFile(
      file,
      `
        const seen = process.env.CHANT_SANDBOX_TEST_SECRET;
        if (seen !== undefined) {
          throw new Error("ambient env leaked: " + seen);
        }
        export const value = { envKeyCount: Object.keys(process.env).length };
      `,
    );

    const previous = process.env.CHANT_SANDBOX_TEST_SECRET;
    process.env.CHANT_SANDBOX_TEST_SECRET = "super-secret-should-not-cross-the-boundary";
    try {
      const result = await runFallbackFilesSandboxed([file], testDir);
      // No error means the fixture's own "if visible, throw" branch never
      // fired — the plain-object export itself isn't a Declarable, so it
      // doesn't land in `result.entities` (collectEntities only collects
      // Declarable/array/composite/LexiconOutput values); absence of the
      // thrown error is the actual proof here.
      expect(result.errors).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.CHANT_SANDBOX_TEST_SECRET;
      else process.env.CHANT_SANDBOX_TEST_SECRET = previous;
    }
  });

  test("runs multiple run-fallback files together, sharing module identity for a cross-file reference", async () => {
    await writeFile(
      join(testDir, "resources.ts"),
      `
        import { createResource } from ${JSON.stringify(runtimePath)};
        export const Bucket = createResource("Test::Bucket", "aws", { arn: "Arn" });
      `,
    );
    await writeFile(
      join(testDir, "storage.ts"),
      `
        import { Bucket } from "./resources";
        export const dataBucket = new Bucket({ name: "data" });
      `,
    );
    const policyFile = join(testDir, "policy.ts");
    await writeFile(
      policyFile,
      `
        import { dataBucket } from "./storage";
        import { createResource } from ${JSON.stringify(runtimePath)};
        const Policy = createResource("Test::Policy", "aws", {});
        export const readPolicy = new Policy({ resource: dataBucket.arn });
      `,
    );

    const result = await runFallbackFilesSandboxed(
      [join(testDir, "resources.ts"), join(testDir, "storage.ts"), policyFile],
      testDir,
    );

    expect(result.errors).toEqual([]);
    expect([...result.entities.keys()].sort()).toEqual(["dataBucket", "readPolicy"]);

    // The cross-file AttrRef (policy.ts's `dataBucket.arn`) must resolve to
    // storage.ts's `dataBucket` BY NAME — proof the two files shared one
    // module graph inside the child, not two separately-imported copies
    // (see ../fold-import.ts's `planFoldTaint` doc for why that distinction
    // is exactly what would otherwise break).
    const readPolicy = result.entities.get("readPolicy") as unknown as { props: { resource: unknown } };
    const ref = readPolicy.props.resource as { getLogicalName?: () => string | undefined; attribute?: string };
    expect(ref.getLogicalName?.()).toBe("dataBucket");
    expect(ref.attribute).toBe("Arn");
  });

  /**
   * chant #1148 — a run-fallback file's own `console.log`/`console.error`
   * used to go nowhere: the child's stdout was piped but never read, and its
   * stderr was captured only for `classifyChildError`'s use, never surfaced
   * on a successful run. `./fork.ts` now relays both, line-buffered and
   * prefixed, to THIS process's stderr — diagnostics crossing as data was
   * never meant to mean incidental output vanishes.
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

    // The child's IPC "message" (what the awaited call resolves on) and its
    // stdout/stderr pipe data are two independent channels — nothing orders
    // one ahead of the other, and #1147 deliberately keeps it that way (see
    // the hang-regression test in policy-boundary.test.ts). Polling briefly
    // rather than asserting immediately avoids a flaky test without giving
    // the production path anything to wait for.
    async function waitFor(lines: string[], matcher: RegExp, timeoutMs = 5000): Promise<void> {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        if (matcher.test(lines.join(""))) return;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error(`stderr never matched ${matcher}. Captured so far:\n${lines.join("")}`);
    }

    test("both console.log and console.error are forwarded, prefixed with [sandbox:run]", async () => {
      const stderr = captureStderr();
      const file = join(testDir, "noisy.ts");
      await writeFile(
        file,
        `
          console.log("hello from run-fallback stdout");
          console.error("hello from run-fallback stderr");
          export const value = "ok";
        `,
      );

      const result = await runFallbackFilesSandboxed([file], testDir);

      expect(result.errors).toEqual([]);
      await waitFor(stderr, /^\[sandbox:run\] hello from run-fallback stdout$/m);
      await waitFor(stderr, /^\[sandbox:run\] hello from run-fallback stderr$/m);
    });

    test("a file that exits hard still has its stderr in the classified error (forwarding doesn't replace capture)", async () => {
      const stderr = captureStderr();
      const file = join(testDir, "crashes.ts");
      await writeFile(
        file,
        `
          console.error("about to exit hard");
          process.exit(1);
        `,
      );

      const result = await runFallbackFilesSandboxed([file], testDir);

      // A hard process.exit() takes the whole bundled child with it — this is
      // fork.ts's pre-existing "child exited before reporting results" path,
      // fed by the SAME stderrBuf that now also feeds forwarding.
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].message).toMatch(/about to exit hard/);

      await waitFor(stderr, /^\[sandbox:run\] about to exit hard$/m);
    });
  });
});
