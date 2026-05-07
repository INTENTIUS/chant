import { describe, test, expect } from "vitest";
import { createMockPlugin, staticDescribeResources } from "./mock-plugin";

describe("createMockPlugin", () => {
  test("returns a plugin with the requested name", () => {
    const plugin = createMockPlugin({ name: "aws" });
    expect(plugin.name).toBe("aws");
    expect(plugin.serializer).toBeDefined();
  });

  test("defaults to 'mock' when no name is given", () => {
    expect(createMockPlugin().name).toBe("mock");
  });

  test("describeResources is undefined unless provided", () => {
    expect(createMockPlugin().describeResources).toBeUndefined();
  });

  test("describeResources is wired through when provided", async () => {
    const plugin = createMockPlugin({
      name: "aws",
      describeResources: staticDescribeResources({
        bucket: { type: "AWS::S3::Bucket", status: "CREATE_COMPLETE" },
      }),
    });
    const result = await plugin.describeResources!({
      environment: "prod",
      buildOutput: "",
      entityNames: ["bucket"],
    });
    expect(result).toEqual({
      bucket: { type: "AWS::S3::Bucket", status: "CREATE_COMPLETE" },
    });
  });

  test("lifecycle methods are no-ops", async () => {
    const plugin = createMockPlugin();
    await expect(plugin.generate()).resolves.toBeUndefined();
    await expect(plugin.validate()).resolves.toBeUndefined();
    await expect(plugin.coverage()).resolves.toBeUndefined();
    await expect(plugin.package()).resolves.toBeUndefined();
  });
});
