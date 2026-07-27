/**
 * Cross-lexicon lifecycle integration (#163) — AWS row.
 *
 * Drives the REAL awsPlugin through core's live-import driver
 * (`liveImportFromPlugins`) and the changeset path (`buildChangeSet`), with the
 * cloud edge (the runtime adapter's spawn) mocked. Proves the seam between core
 * and a real lexicon — not a `createMockPlugin` fixture.
 */
import { describe, test, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Partial mock (`importOriginal`) rather than a full replacement: this module
// is reachable — via `@intentius/chant`'s own root barrel, not just this
// test's direct imports — from other real exports the plugin/import path
// touches (e.g. `moduleDir`, which `../../lint/config.ts` calls at module
// scope), so replacing the whole module wholesale breaks anything that
// transitively loads one of those, for reasons entirely unrelated to what
// this test is mocking (`spawn`).
const spawnMock = vi.fn();
vi.mock("@intentius/chant/runtime-adapter", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@intentius/chant/runtime-adapter")>();
  return { ...actual, getRuntime: () => ({ ...actual.getRuntime(), spawn: spawnMock }) };
});

const { awsPlugin } = await import("./plugin");
const { liveImportFromPlugins } = await import("@intentius/chant/cli/commands/import");
const { buildChangeSet } = await import("@intentius/chant/lifecycle/change-set");

const liveTemplate = {
  AWSTemplateFormatVersion: "2010-09-09",
  Resources: {
    MyBucket: { Type: "AWS::S3::Bucket", Properties: { BucketName: "my-bucket" } },
  },
};

const ok = (stdout: string) => ({ stdout, stderr: "", exitCode: 0 });

describe("aws lifecycle integration (#163)", () => {
  beforeEach(() => spawnMock.mockReset());

  test("live-import driver: real exportResources → IR → generated source", async () => {
    spawnMock.mockResolvedValue(ok(JSON.stringify({ TemplateBody: liveTemplate })));
    const output = mkdtempSync(join(tmpdir(), "chant-aws-li-"));
    try {
      const result = await liveImportFromPlugins([awsPlugin], {
        environment: "prod",
        output,
        force: true,
      });
      expect(result.success).toBe(true);
      expect(result.generatedFiles.length).toBeGreaterThan(0);
      const all = readdirSync(output)
        .map((f) => readFileSync(join(output, f), "utf-8"))
        .join("\n");
      expect(all).toContain("new Bucket(");
      expect(all).toContain("BucketName");
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  });

  test("changeset path: real describeResources → buildChangeSet verdicts", async () => {
    // describe-stack-resources then describe-stacks.
    spawnMock.mockImplementation((argv?: string[]) => {
      if (argv?.includes("describe-stack-resources")) {
        return Promise.resolve(
          ok(
            JSON.stringify({
              StackResources: [
                {
                  LogicalResourceId: "MyBucket",
                  ResourceType: "AWS::S3::Bucket",
                  PhysicalResourceId: "my-bucket",
                  ResourceStatus: "CREATE_COMPLETE",
                  Timestamp: "2026-01-01T00:00:00Z",
                },
              ],
            }),
          ),
        );
      }
      return Promise.resolve(ok(JSON.stringify({ Stacks: [{ Outputs: [] }] })));
    });

    const observedNow = await awsPlugin.describeResources!({
      environment: "prod",
      buildOutput: "",
      entityNames: ["MyBucket"],
    });
    expect(observedNow.MyBucket?.type).toBe("AWS::S3::Bucket");

    // Declared "MyQueue" is absent from live → create; live "MyBucket" is
    // undeclared and unmarked → adopt (never delete without ownership).
    const cs = buildChangeSet("prod", {
      declared: new Set(["MyQueue"]),
      observedNow,
      observedThen: undefined,
    });
    const byName = Object.fromEntries(cs.entries.map((e) => [e.name, e.action]));
    expect(byName.MyQueue).toBe("create");
    expect(byName.MyBucket).toBe("adopt");

    // Declared + live with no drift → noop.
    const cs2 = buildChangeSet("prod", {
      declared: new Set(["MyBucket"]),
      observedNow,
      observedThen: undefined,
    });
    expect(cs2.entries.find((e) => e.name === "MyBucket")!.action).toBe("noop");
  });

  describe("describeStackStatus (#57 — per-component stack presence)", () => {
    const err = (stderr: string) => ({ stdout: "", stderr, exitCode: 255 });

    test("present + healthy for a terminal-success stack", async () => {
      spawnMock.mockResolvedValue(ok(JSON.stringify({ Stacks: [{ StackStatus: "CREATE_COMPLETE" }] })));
      const obs = await awsPlugin.describeStackStatus!({ environment: "local", stack: "loom-local-a-loom-db" });
      expect(obs).toEqual({ stack: "loom-local-a-loom-db", present: true, status: "CREATE_COMPLETE", healthy: true });
    });

    test("present but not healthy for a rollback/failed state", async () => {
      spawnMock.mockResolvedValue(ok(JSON.stringify({ Stacks: [{ StackStatus: "ROLLBACK_COMPLETE" }] })));
      const obs = await awsPlugin.describeStackStatus!({ environment: "local", stack: "s" });
      expect(obs).toMatchObject({ present: true, status: "ROLLBACK_COMPLETE", healthy: false });
    });

    test("in-progress is present but not yet healthy", async () => {
      spawnMock.mockResolvedValue(ok(JSON.stringify({ Stacks: [{ StackStatus: "UPDATE_IN_PROGRESS" }] })));
      const obs = await awsPlugin.describeStackStatus!({ environment: "local", stack: "s" });
      expect(obs).toMatchObject({ present: true, healthy: false });
    });

    test("absent (does-not-exist) reports present: false, not an error", async () => {
      spawnMock.mockResolvedValue(err("ValidationError: Stack with id s does not exist"));
      const obs = await awsPlugin.describeStackStatus!({ environment: "local", stack: "s" });
      expect(obs).toEqual({ stack: "s", present: false });
    });

    test("any other CLI failure is indeterminate → null (never a false 'gone')", async () => {
      spawnMock.mockResolvedValue(err("Unable to locate credentials"));
      const obs = await awsPlugin.describeStackStatus!({ environment: "local", stack: "s" });
      expect(obs).toBeNull();
    });
  });
});
