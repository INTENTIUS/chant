import { describe, test, expect } from "vitest";
import { createPostSynthContext } from "@intentius/chant-test-utils";
import { waw047, checkEcsPrivilegedContainer } from "./waw047";

function makeCtx(template: object) {
  return createPostSynthContext({ aws: template });
}

describe("WAW047: ECS Privileged Container", () => {
  test("check metadata", () => {
    expect(waw047.id).toBe("WAW047");
    expect(waw047.description).toContain("privileged");
  });

  test("flags a container with Privileged: true", () => {
    const ctx = makeCtx({
      Resources: {
        MyTask: {
          Type: "AWS::ECS::TaskDefinition",
          Properties: {
            ContainerDefinitions: [{ Name: "app", Privileged: true }],
          },
        },
      },
    });
    const diags = checkEcsPrivilegedContainer(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("WAW047");
    expect(diags[0].message).toContain("app");
  });

  test("no diagnostic when Privileged is false or unset", () => {
    const ctx = makeCtx({
      Resources: {
        MyTask: {
          Type: "AWS::ECS::TaskDefinition",
          Properties: {
            ContainerDefinitions: [{ Name: "app", Privileged: false }, { Name: "sidecar" }],
          },
        },
      },
    });
    expect(checkEcsPrivilegedContainer(ctx)).toHaveLength(0);
  });

  test("skips intrinsic Privileged values", () => {
    const ctx = makeCtx({
      Resources: {
        MyTask: {
          Type: "AWS::ECS::TaskDefinition",
          Properties: { ContainerDefinitions: [{ Name: "app", Privileged: { Ref: "PrivParam" } }] },
        },
      },
    });
    expect(checkEcsPrivilegedContainer(ctx)).toHaveLength(0);
  });

  test("no diagnostic for non-TaskDefinition resources", () => {
    const ctx = makeCtx({
      Resources: { MyBucket: { Type: "AWS::S3::Bucket", Properties: {} } },
    });
    expect(checkEcsPrivilegedContainer(ctx)).toHaveLength(0);
  });
});
