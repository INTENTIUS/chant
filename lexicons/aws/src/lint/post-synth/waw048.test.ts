import { describe, test, expect } from "vitest";
import { createPostSynthContext } from "@intentius/chant-test-utils";
import { waw048, checkEcsLogConfiguration } from "./waw048";

function makeCtx(template: object) {
  return createPostSynthContext({ aws: template });
}

describe("WAW048: ECS Missing Log Configuration", () => {
  test("check metadata", () => {
    expect(waw048.id).toBe("WAW048");
    expect(waw048.description).toContain("LogConfiguration");
  });

  test("flags a container without LogConfiguration", () => {
    const ctx = makeCtx({
      Resources: {
        MyTask: {
          Type: "AWS::ECS::TaskDefinition",
          Properties: { ContainerDefinitions: [{ Name: "app" }] },
        },
      },
    });
    const diags = checkEcsLogConfiguration(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("WAW048");
    expect(diags[0].severity).toBe("warning");
  });

  test("no diagnostic when LogConfiguration is present", () => {
    const ctx = makeCtx({
      Resources: {
        MyTask: {
          Type: "AWS::ECS::TaskDefinition",
          Properties: {
            ContainerDefinitions: [
              {
                Name: "app",
                LogConfiguration: {
                  LogDriver: "awslogs",
                  Options: { "awslogs-group": "/ecs/app", "awslogs-region": "us-east-1", "awslogs-stream-prefix": "app" },
                },
              },
            ],
          },
        },
      },
    });
    expect(checkEcsLogConfiguration(ctx)).toHaveLength(0);
  });

  test("flags each container in a multi-container task independently", () => {
    const ctx = makeCtx({
      Resources: {
        MyTask: {
          Type: "AWS::ECS::TaskDefinition",
          Properties: {
            ContainerDefinitions: [
              { Name: "app", LogConfiguration: { LogDriver: "awslogs" } },
              { Name: "sidecar" },
            ],
          },
        },
      },
    });
    const diags = checkEcsLogConfiguration(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("sidecar");
  });

  test("no diagnostic for non-TaskDefinition resources", () => {
    const ctx = makeCtx({
      Resources: { MyBucket: { Type: "AWS::S3::Bucket", Properties: {} } },
    });
    expect(checkEcsLogConfiguration(ctx)).toHaveLength(0);
  });
});
