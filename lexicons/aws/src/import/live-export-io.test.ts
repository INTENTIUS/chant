import { describe, test, expect, vi, beforeEach } from "vitest";

// AWS exportResources reaches the cloud through the runtime adapter's spawn
// (not node:child_process), so the I/O seam is the runtime-adapter module.
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

import { awsPlugin } from "../plugin";

const liveTemplate = {
  AWSTemplateFormatVersion: "2010-09-09",
  Resources: {
    MyBucket: {
      Type: "AWS::S3::Bucket",
      Properties: { BucketName: "my-bucket" },
    },
  },
};

describe("aws exportResources I/O glue (#160)", () => {
  beforeEach(() => spawnMock.mockReset());

  test("spawns `cloudformation get-template` for the env stack and maps the body", async () => {
    spawnMock.mockResolvedValue({
      stdout: JSON.stringify({ TemplateBody: liveTemplate }),
      stderr: "",
      exitCode: 0,
    });
    const ir = await awsPlugin.exportResources!({ environment: "prod" });
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const argv = spawnMock.mock.calls[0][0] as string[];
    expect(argv).toEqual(
      expect.arrayContaining([
        "aws", "cloudformation", "get-template",
        "--stack-name", "prod",
        "--output", "json",
      ]),
    );
    expect(ir.resources.map((r) => r.logicalId)).toEqual(["MyBucket"]);
  });

  test("a not-yet-deployed stack returns empty live state (pre-first-apply), not an error", async () => {
    spawnMock.mockResolvedValue({
      stdout: "",
      stderr: "An error occurred (ValidationError) …: Stack with id ghost does not exist",
      exitCode: 254,
    });
    const ir = await awsPlugin.exportResources!({ environment: "ghost" });
    expect(ir.resources).toEqual([]);
  });

  test("a genuine failure (not 'does not exist') still throws with the stderr surfaced", async () => {
    spawnMock.mockResolvedValue({
      stdout: "",
      stderr: "An error occurred (AccessDenied) …: not authorized",
      exitCode: 254,
    });
    await expect(awsPlugin.exportResources!({ environment: "prod" })).rejects.toThrow(
      /Failed to get template for stack "prod".*AccessDenied/,
    );
  });

  test("a stack with no TemplateBody throws", async () => {
    spawnMock.mockResolvedValue({ stdout: JSON.stringify({}), stderr: "", exitCode: 0 });
    await expect(awsPlugin.exportResources!({ environment: "prod" })).rejects.toThrow(
      /no TemplateBody/,
    );
  });
});
