import { describe, test, expect } from "vitest";
import { createPostSynthContext } from "@intentius/chant-test-utils";
import { waw039, checkRdsBackupRetention } from "./waw039";

function makeCtx(template: object) {
  return createPostSynthContext({ aws: template });
}

describe("WAW039: RDS Backup Retention Not Set", () => {
  test("check metadata", () => {
    expect(waw039.id).toBe("WAW039");
    expect(waw039.description).toContain("backups");
  });

  test("flags DBInstance with BackupRetentionPeriod: 0", () => {
    const ctx = makeCtx({
      Resources: {
        MyDB: {
          Type: "AWS::RDS::DBInstance",
          Properties: { DBInstanceClass: "db.t3.micro", BackupRetentionPeriod: 0 },
        },
      },
    });
    const diags = checkRdsBackupRetention(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("WAW039");
    expect(diags[0].severity).toBe("error");
  });

  test("flags DBCluster missing BackupRetentionPeriod", () => {
    const ctx = makeCtx({
      Resources: {
        MyCluster: {
          Type: "AWS::RDS::DBCluster",
          Properties: { Engine: "aurora-mysql" },
        },
      },
    });
    expect(checkRdsBackupRetention(ctx)).toHaveLength(1);
  });

  test("no diagnostic with a positive BackupRetentionPeriod", () => {
    const ctx = makeCtx({
      Resources: {
        MyDB: {
          Type: "AWS::RDS::DBInstance",
          Properties: { BackupRetentionPeriod: 7 },
        },
      },
    });
    expect(checkRdsBackupRetention(ctx)).toHaveLength(0);
  });

  test("skips intrinsic value for BackupRetentionPeriod", () => {
    const ctx = makeCtx({
      Resources: {
        MyDB: {
          Type: "AWS::RDS::DBInstance",
          Properties: { BackupRetentionPeriod: { Ref: "RetentionParam" } },
        },
      },
    });
    expect(checkRdsBackupRetention(ctx)).toHaveLength(0);
  });

  test("no diagnostic for non-RDS resources", () => {
    const ctx = makeCtx({
      Resources: { MyBucket: { Type: "AWS::S3::Bucket", Properties: {} } },
    });
    expect(checkRdsBackupRetention(ctx)).toHaveLength(0);
  });
});
