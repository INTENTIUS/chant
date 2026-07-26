import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { discoverComponentsSandboxed } from "./run";

/**
 * chant #1051 — proves the actual isolation properties for sandboxed
 * component discovery (not just that it returns the right components),
 * mirroring `../../discovery/sandbox/run.test.ts`'s coverage for the
 * lexicon-resource run-fallback path (chant #1045 Phase 2): a hostile
 * `*.component.ts` file cannot read outside the project directory, write
 * anywhere, spawn a process, or read the ambient environment, and a
 * permission denial names the file and the operation rather than leaking a
 * raw `ERR_ACCESS_DENIED`.
 *
 * Fixtures are written to a fresh tmpdir per test, never into the source
 * tree.
 */
describe("discoverComponentsSandboxed — isolation", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await realpath(
      await (async () => {
        const dir = join(tmpdir(), `chant-component-sandbox-run-test-${Date.now()}-${Math.random()}`);
        await mkdir(dir, { recursive: true });
        return dir;
      })(),
    );
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  test("denies filesystem reads outside the project directory, naming the file and the operation", async () => {
    const file = join(testDir, "evil.component.ts");
    await writeFile(
      file,
      `
        import { readFileSync } from "node:fs";
        readFileSync("/etc/hosts", "utf-8");
        export const evil = { name: "evil", dependsOn: [], deploy: [{ phase: "Apply", steps: [{ kind: "shell" }] }] };
      `,
    );

    const result = await discoverComponentsSandboxed([file], testDir);

    expect(result.components.size).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].file).toBe(file);
    expect(result.errors[0].type).toBe("permission");
    expect(result.errors[0].message).toMatch(/FileSystemRead/);
    expect(result.errors[0].message).toContain(file);
  });

  test("denies filesystem writes anywhere", async () => {
    const file = join(testDir, "evil.component.ts");
    const targetPath = join(testDir, "..", "escaped.txt");
    await writeFile(
      file,
      `
        import { writeFileSync } from "node:fs";
        writeFileSync(${JSON.stringify(targetPath)}, "pwned");
        export const evil = { name: "evil", dependsOn: [], deploy: [{ phase: "Apply", steps: [{ kind: "shell" }] }] };
      `,
    );

    const result = await discoverComponentsSandboxed([file], testDir);

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].type).toBe("permission");
    expect(result.errors[0].message).toMatch(/FileSystemWrite/);
    expect(existsSync(targetPath)).toBe(false);
  });

  test("denies spawning a child process", async () => {
    const file = join(testDir, "evil.component.ts");
    const markerPath = join(testDir, "spawned.txt");
    await writeFile(
      file,
      `
        import { execSync } from "node:child_process";
        execSync(${JSON.stringify(`touch ${markerPath}`)});
        export const evil = { name: "evil", dependsOn: [], deploy: [{ phase: "Apply", steps: [{ kind: "shell" }] }] };
      `,
    );

    const result = await discoverComponentsSandboxed([file], testDir);

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].type).toBe("permission");
    expect(result.errors[0].message).toMatch(/ChildProcess/);
    expect(existsSync(markerPath)).toBe(false);
  });

  test("scrubs the ambient environment — a real secret set on the parent's process.env is invisible to project source", async () => {
    const file = join(testDir, "evil.component.ts");
    await writeFile(
      file,
      `
        const seen = process.env.CHANT_SANDBOX_TEST_SECRET;
        if (seen !== undefined) {
          throw new Error("ambient env leaked: " + seen);
        }
        export const evil = {
          name: "evil",
          dependsOn: [],
          deploy: [{ phase: "Apply", steps: [{ kind: "shell", envKeyCount: Object.keys(process.env).length }] }],
        };
      `,
    );

    const previous = process.env.CHANT_SANDBOX_TEST_SECRET;
    process.env.CHANT_SANDBOX_TEST_SECRET = "super-secret-should-not-cross-the-boundary";
    try {
      const result = await discoverComponentsSandboxed([file], testDir);
      expect(result.errors).toEqual([]);
      expect(result.components.has("evil")).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.CHANT_SANDBOX_TEST_SECRET;
      else process.env.CHANT_SANDBOX_TEST_SECRET = previous;
    }
  });

  test("the same component object re-exported under two bindings in one file is NOT a duplicate — the identity check runs on live objects, before any serialization", async () => {
    // `collectComponents`'s dedupe check (`../discover.ts`) compares
    // candidates with `existing.component !== value` — real object identity,
    // not deep equality. That distinction only matters if the check runs
    // over the LIVE, still-in-memory export values: had this instead run
    // over a JSON-round-tripped copy (e.g. serialize each file's exports in
    // the child, decode in the parent, THEN dedupe), `JSON.parse` never
    // returns the same reference twice, so even this legitimate case — one
    // object, two export bindings — would wrongly report a duplicate. This
    // proves the sandboxed path preserves the unsandboxed behavior: the
    // dedupe collector (`collectComponents`) runs bundled INSIDE the child,
    // over the driver's own live `modules` array, before the one
    // `JSON.stringify` at the very end (`./driver.ts`).
    const file = join(testDir, "aliased.component.ts");
    await writeFile(
      file,
      `
        const base = {
          name: "search-service",
          dependsOn: [],
          deploy: [{ phase: "Apply", steps: [{ kind: "shell" }] }],
        };
        export const searchService = base;
        export const searchServiceAlias = base;
      `,
    );

    const result = await discoverComponentsSandboxed([file], testDir);

    expect(result.errors).toEqual([]);
    expect(result.components.size).toBe(1);
    expect(result.components.has("search-service")).toBe(true);
  });

  test("a genuine duplicate — two DIFFERENT objects declaring the same component name — is still reported", async () => {
    await writeFile(
      join(testDir, "one.component.ts"),
      `
        export const svc = { name: "dup", dependsOn: [], deploy: [{ phase: "Apply", steps: [{ kind: "shell" }] }] };
      `,
    );
    await writeFile(
      join(testDir, "two.component.ts"),
      `
        export const svcAgain = { name: "dup", dependsOn: [], deploy: [{ phase: "Apply", steps: [{ kind: "shell" }] }] };
      `,
    );

    const result = await discoverComponentsSandboxed(
      [join(testDir, "one.component.ts"), join(testDir, "two.component.ts")],
      testDir,
    );

    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0].type).toBe("resolution");
    expect(result.errors[0].message).toMatch(/Duplicate component name "dup"/);
  });
});
