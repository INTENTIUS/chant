import { describe, test, expect, beforeEach, afterEach } from "vitest";
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
});
