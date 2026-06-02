import { describe, test, expect, vi, beforeEach } from "vitest";

// AWS exportResources reaches the cloud through the runtime adapter's spawn
// (not node:child_process), so the I/O seam is the runtime-adapter module.
const spawnMock = vi.fn();
vi.mock("@intentius/chant/runtime-adapter", () => ({
  getRuntime: () => ({ spawn: spawnMock }),
}));

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

  test("a non-zero exit throws with the stderr surfaced", async () => {
    spawnMock.mockResolvedValue({
      stdout: "",
      stderr: "Stack with id ghost does not exist",
      exitCode: 254,
    });
    await expect(awsPlugin.exportResources!({ environment: "ghost" })).rejects.toThrow(
      /Failed to get template for stack "ghost".*does not exist/,
    );
  });

  test("a stack with no TemplateBody throws", async () => {
    spawnMock.mockResolvedValue({ stdout: JSON.stringify({}), stderr: "", exitCode: 0 });
    await expect(awsPlugin.exportResources!({ environment: "prod" })).rejects.toThrow(
      /no TemplateBody/,
    );
  });
});
