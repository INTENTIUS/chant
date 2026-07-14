import { describe, test, expect } from "vitest";
import { createPostSynthContext } from "@intentius/chant-test-utils";
import { waw046, checkEcsPlaintextSecrets } from "./waw046";

function makeCtx(template: object) {
  return createPostSynthContext({ aws: template });
}

describe("WAW046: ECS Secret-Looking Value In Plaintext Environment", () => {
  test("check metadata", () => {
    expect(waw046.id).toBe("WAW046");
    expect(waw046.description).toContain("Secrets");
  });

  test("flags a DB_PASSWORD environment variable", () => {
    const ctx = makeCtx({
      Resources: {
        MyTask: {
          Type: "AWS::ECS::TaskDefinition",
          Properties: {
            ContainerDefinitions: [
              { Name: "app", Environment: [{ Name: "DB_PASSWORD", Value: "hunter2" }] },
            ],
          },
        },
      },
    });
    const diags = checkEcsPlaintextSecrets(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("WAW046");
    expect(diags[0].message).toContain("DB_PASSWORD");
  });

  test("flags API_KEY, TOKEN, and CREDENTIAL variants", () => {
    const ctx = makeCtx({
      Resources: {
        MyTask: {
          Type: "AWS::ECS::TaskDefinition",
          Properties: {
            ContainerDefinitions: [
              {
                Name: "app",
                Environment: [
                  { Name: "STRIPE_API_KEY", Value: "sk_live_x" },
                  { Name: "AUTH_TOKEN", Value: "x" },
                  { Name: "AWS_CREDENTIAL_BLOB", Value: "x" },
                ],
              },
            ],
          },
        },
      },
    });
    expect(checkEcsPlaintextSecrets(ctx)).toHaveLength(3);
  });

  test("no diagnostic for non-secret-looking environment names", () => {
    const ctx = makeCtx({
      Resources: {
        MyTask: {
          Type: "AWS::ECS::TaskDefinition",
          Properties: {
            ContainerDefinitions: [
              { Name: "app", Environment: [{ Name: "LOG_LEVEL", Value: "info" }] },
            ],
          },
        },
      },
    });
    expect(checkEcsPlaintextSecrets(ctx)).toHaveLength(0);
  });

  test("no diagnostic when the secret is passed via Secrets instead", () => {
    const ctx = makeCtx({
      Resources: {
        MyTask: {
          Type: "AWS::ECS::TaskDefinition",
          Properties: {
            ContainerDefinitions: [
              {
                Name: "app",
                Secrets: [{ Name: "DB_PASSWORD", ValueFrom: "arn:aws:secretsmanager:...:secret:db-pw" }],
              },
            ],
          },
        },
      },
    });
    expect(checkEcsPlaintextSecrets(ctx)).toHaveLength(0);
  });

  test("skips intrinsic Name values", () => {
    const ctx = makeCtx({
      Resources: {
        MyTask: {
          Type: "AWS::ECS::TaskDefinition",
          Properties: {
            ContainerDefinitions: [{ Name: "app", Environment: [{ Name: { Ref: "NameParam" }, Value: "x" }] }],
          },
        },
      },
    });
    expect(checkEcsPlaintextSecrets(ctx)).toHaveLength(0);
  });

  test("no diagnostic for non-TaskDefinition resources", () => {
    const ctx = makeCtx({
      Resources: { MyBucket: { Type: "AWS::S3::Bucket", Properties: {} } },
    });
    expect(checkEcsPlaintextSecrets(ctx)).toHaveLength(0);
  });
});
