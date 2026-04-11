import { describe, test, expect } from "vitest";
import { createPostSynthContext } from "@intentius/chant-test-utils";
import { waw036, checkNonAsciiProps } from "./waw036";

function makeCtx(template: object) {
  return createPostSynthContext({ aws: template });
}

describe("WAW036: Non-ASCII Characters in String Properties", () => {
  test("check metadata", () => {
    expect(waw036.id).toBe("WAW036");
    expect(waw036.description.toLowerCase()).toContain("non-ascii");
  });

  // ── SecurityGroup.GroupDescription ───────────────────────────────

  test("GroupDescription with em-dash → error", () => {
    const ctx = makeCtx({
      Resources: {
        MySg: {
          Type: "AWS::EC2::SecurityGroup",
          Properties: {
            GroupDescription: "cluster nodes \u2014 Slurm",
            VpcId: "vpc-123",
          },
        },
      },
    });
    const diags = checkNonAsciiProps(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("WAW036");
    expect(diags[0].severity).toBe("error");
    expect(diags[0].entity).toBe("MySg");
    expect(diags[0].message).toContain("GroupDescription");
    expect(diags[0].message).toContain("U+2014");
  });

  test("GroupDescription with ASCII only → no diagnostic", () => {
    const ctx = makeCtx({
      Resources: {
        MySg: {
          Type: "AWS::EC2::SecurityGroup",
          Properties: {
            GroupDescription: "cluster nodes - Slurm",
            VpcId: "vpc-123",
          },
        },
      },
    });
    const diags = checkNonAsciiProps(ctx);
    expect(diags).toHaveLength(0);
  });

  // ── CloudWatch.AlarmDescription ──────────────────────────────────

  test("AlarmDescription with curly quote → error", () => {
    const ctx = makeCtx({
      Resources: {
        MyAlarm: {
          Type: "AWS::CloudWatch::Alarm",
          Properties: {
            AlarmName: "my-alarm",
            AlarmDescription: "FSx throughput \u201chigh\u201d",
            MetricName: "BytesReadFromDisk",
            Namespace: "AWS/FSx",
            Period: 300,
            EvaluationPeriods: 1,
            Threshold: 1000,
            ComparisonOperator: "GreaterThanThreshold",
          },
        },
      },
    });
    const diags = checkNonAsciiProps(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].entity).toBe("MyAlarm");
    expect(diags[0].message).toContain("AlarmDescription");
  });

  test("AlarmName with accented char → error", () => {
    const ctx = makeCtx({
      Resources: {
        MyAlarm: {
          Type: "AWS::CloudWatch::Alarm",
          Properties: {
            AlarmName: "m\u00e9trique-alarm",
            AlarmDescription: "normal",
            MetricName: "CPUUtilization",
            Namespace: "AWS/EC2",
            Period: 60,
            EvaluationPeriods: 1,
            Threshold: 80,
            ComparisonOperator: "GreaterThanThreshold",
          },
        },
      },
    });
    const diags = checkNonAsciiProps(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("AlarmName");
  });

  // ── IAM::Role.RoleName ───────────────────────────────────────────

  test("RoleName with non-ASCII → error", () => {
    const ctx = makeCtx({
      Resources: {
        MyRole: {
          Type: "AWS::IAM::Role",
          Properties: {
            RoleName: "role\u2013name",
            AssumeRolePolicyDocument: {},
          },
        },
      },
    });
    const diags = checkNonAsciiProps(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("RoleName");
    expect(diags[0].message).toContain("U+2013");
  });

  // ── AutoScalingGroup.AutoScalingGroupName ────────────────────────

  test("AutoScalingGroupName with non-ASCII → error", () => {
    const ctx = makeCtx({
      Resources: {
        MyAsg: {
          Type: "AWS::AutoScaling::AutoScalingGroup",
          Properties: {
            AutoScalingGroupName: "asg\u2014prod",
            MinSize: "0",
            MaxSize: "10",
          },
        },
      },
    });
    const diags = checkNonAsciiProps(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].entity).toBe("MyAsg");
  });

  // ── Non-string (intrinsic) values are skipped ────────────────────

  test("GroupDescription as Ref intrinsic → no diagnostic", () => {
    const ctx = makeCtx({
      Resources: {
        MySg: {
          Type: "AWS::EC2::SecurityGroup",
          Properties: {
            GroupDescription: { Ref: "SomeParam" },
            VpcId: "vpc-123",
          },
        },
      },
    });
    const diags = checkNonAsciiProps(ctx);
    expect(diags).toHaveLength(0);
  });

  // ── Multiple violations ──────────────────────────────────────────

  test("multiple resources with non-ASCII → multiple diagnostics", () => {
    const ctx = makeCtx({
      Resources: {
        Sg1: {
          Type: "AWS::EC2::SecurityGroup",
          Properties: {
            GroupDescription: "sg \u2014 one",
            VpcId: "vpc-123",
          },
        },
        Sg2: {
          Type: "AWS::EC2::SecurityGroup",
          Properties: {
            GroupDescription: "sg \u2014 two",
            VpcId: "vpc-456",
          },
        },
        CleanSg: {
          Type: "AWS::EC2::SecurityGroup",
          Properties: {
            GroupDescription: "clean sg",
            VpcId: "vpc-789",
          },
        },
      },
    });
    const diags = checkNonAsciiProps(ctx);
    expect(diags).toHaveLength(2);
    const entities = diags.map((d) => d.entity).sort();
    expect(entities).toEqual(["Sg1", "Sg2"]);
  });

  // ── Resource types not in the list ──────────────────────────────

  test("unmonitored resource type with non-ASCII → no diagnostic", () => {
    const ctx = makeCtx({
      Resources: {
        MyTable: {
          Type: "AWS::DynamoDB::Table",
          Properties: {
            TableName: "table\u2014name",
          },
        },
      },
    });
    const diags = checkNonAsciiProps(ctx);
    expect(diags).toHaveLength(0);
  });

  test("empty Resources → no diagnostic", () => {
    const ctx = makeCtx({ Resources: {} });
    const diags = checkNonAsciiProps(ctx);
    expect(diags).toHaveLength(0);
  });
});
