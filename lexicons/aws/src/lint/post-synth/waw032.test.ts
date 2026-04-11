import { describe, test, expect } from "vitest";
import { createPostSynthContext } from "@intentius/chant-test-utils";
import { waw032, checkEfsTransitEncryption } from "./waw032";

function makeCtx(template: object) {
  return createPostSynthContext({ aws: template });
}

describe("WAW032: EFS Transit Encryption Disabled", () => {
  test("check metadata", () => {
    expect(waw032.id).toBe("WAW032");
    expect(waw032.description).toContain("transit encryption");
  });

  test("flags task with DISABLED transit encryption", () => {
    const ctx = makeCtx({
      Resources: {
        MyTask: {
          Type: "AWS::ECS::TaskDefinition",
          Properties: {
            Volumes: [
              {
                Name: "solr-data",
                EFSVolumeConfiguration: {
                  FileSystemId: "fs-abc123",
                  TransitEncryption: "DISABLED",
                },
              },
            ],
          },
        },
      },
    });
    const diags = checkEfsTransitEncryption(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("WAW032");
    expect(diags[0].severity).toBe("warning");
    expect(diags[0].entity).toBe("MyTask");
  });

  test("no diagnostic when transit encryption is ENABLED", () => {
    const ctx = makeCtx({
      Resources: {
        MyTask: {
          Type: "AWS::ECS::TaskDefinition",
          Properties: {
            Volumes: [
              {
                Name: "solr-data",
                EFSVolumeConfiguration: {
                  FileSystemId: "fs-abc123",
                  TransitEncryption: "ENABLED",
                },
              },
            ],
          },
        },
      },
    });
    expect(checkEfsTransitEncryption(ctx)).toHaveLength(0);
  });

  test("no diagnostic when no EFS volumes", () => {
    const ctx = makeCtx({
      Resources: {
        MyTask: {
          Type: "AWS::ECS::TaskDefinition",
          Properties: { Volumes: [] },
        },
      },
    });
    expect(checkEfsTransitEncryption(ctx)).toHaveLength(0);
  });

  test("ignores non-task resources", () => {
    const ctx = makeCtx({
      Resources: {
        MyBucket: { Type: "AWS::S3::Bucket", Properties: {} },
      },
    });
    expect(checkEfsTransitEncryption(ctx)).toHaveLength(0);
  });
});
