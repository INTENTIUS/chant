import { describe, test, expect } from "vitest";
import { createPostSynthContext } from "@intentius/chant-test-utils";
import { waw059, checkWildcardResourceEnumerable } from "./waw059";

function makeCtx(template: object) {
  return createPostSynthContext({ aws: template });
}

const TRUST = {
  Version: "2012-10-17",
  Statement: [
    {
      Effect: "Allow",
      Principal: { Service: "lambda.amazonaws.com" },
      Action: "sts:AssumeRole",
    },
  ],
};

function role(statement: Record<string, unknown>) {
  return {
    Type: "AWS::IAM::Role",
    Properties: {
      AssumeRolePolicyDocument: TRUST,
      Policies: [
        {
          PolicyName: "app",
          PolicyDocument: { Version: "2012-10-17", Statement: [statement] },
        },
      ],
    },
  };
}

function lambda(env: Record<string, unknown>) {
  return {
    Type: "AWS::Lambda::Function",
    Properties: {
      Runtime: "nodejs20.x",
      Handler: "index.handler",
      Role: { "Fn::GetAtt": ["AppRole", "Arn"] },
      Environment: { Variables: env },
    },
  };
}

const BUCKET = { Type: "AWS::S3::Bucket", Properties: {} };
const TABLE = { Type: "AWS::DynamoDB::Table", Properties: { BillingMode: "PAY_PER_REQUEST" } };
const QUEUE = { Type: "AWS::SQS::Queue", Properties: {} };

describe("WAW059: wildcard Resource where the declared graph enumerates the touched set", () => {
  test("check metadata", () => {
    expect(waw059.id).toBe("WAW059");
    expect(waw059.description).toContain("declared graph");
  });

  test("flags an over-broad role inline statement and suggests the declared Arns", () => {
    const ctx = makeCtx({
      Resources: {
        DataBucket: BUCKET,
        AppRole: role({
          Effect: "Allow",
          Action: ["s3:GetObject", "s3:PutObject"],
          Resource: "*",
        }),
        AppFunc: lambda({ BUCKET_NAME: { Ref: "DataBucket" } }),
      },
    });
    const diags = checkWildcardResourceEnumerable(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("WAW059");
    expect(diags[0].severity).toBe("warning");
    expect(diags[0].entity).toBe("AppRole");
    expect(diags[0].message).toContain('{"Fn::GetAtt":["DataBucket","Arn"]}');
    expect(diags[0].message).toContain('"/*"');
  });

  test("flags a service-wide ARN pattern, not just the bare wildcard", () => {
    const ctx = makeCtx({
      Resources: {
        Jobs: TABLE,
        AppRole: role({
          Effect: "Allow",
          Action: ["dynamodb:GetItem", "dynamodb:Query"],
          Resource: "arn:aws:dynamodb:*:*:table/*",
        }),
        AppFunc: lambda({ TABLE_NAME: { Ref: "Jobs" } }),
      },
    });
    const diags = checkWildcardResourceEnumerable(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain('{"Fn::GetAtt":["Jobs","Arn"]}');
  });

  test("flags an IAM::Policy attached to a declared role via Ref", () => {
    const ctx = makeCtx({
      Resources: {
        WorkQueue: QUEUE,
        AppRole: { Type: "AWS::IAM::Role", Properties: { AssumeRolePolicyDocument: TRUST } },
        AppPolicy: {
          Type: "AWS::IAM::Policy",
          Properties: {
            PolicyName: "app",
            Roles: [{ Ref: "AppRole" }],
            PolicyDocument: {
              Version: "2012-10-17",
              Statement: [{ Effect: "Allow", Action: "sqs:SendMessage", Resource: "*" }],
            },
          },
        },
        AppFunc: lambda({ QUEUE_URL: { Ref: "WorkQueue" } }),
      },
    });
    const diags = checkWildcardResourceEnumerable(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].entity).toBe("AppPolicy");
    expect(diags[0].message).toContain('{"Fn::GetAtt":["WorkQueue","Arn"]}');
  });

  test("exact-scoped statement is quiet", () => {
    const ctx = makeCtx({
      Resources: {
        DataBucket: BUCKET,
        AppRole: role({
          Effect: "Allow",
          Action: ["s3:GetObject"],
          Resource: [{ "Fn::GetAtt": ["DataBucket", "Arn"] }],
        }),
        AppFunc: lambda({ BUCKET_NAME: { Ref: "DataBucket" } }),
      },
    });
    expect(checkWildcardResourceEnumerable(ctx)).toHaveLength(0);
  });

  test("foreign edge (literal service ARN in a consumer) is quiet", () => {
    const ctx = makeCtx({
      Resources: {
        DataBucket: BUCKET,
        AppRole: role({ Effect: "Allow", Action: "s3:GetObject", Resource: "*" }),
        AppFunc: lambda({
          BUCKET_NAME: { Ref: "DataBucket" },
          EXTERNAL_BUCKET: "arn:aws:s3:::partner-drop-zone",
        }),
      },
    });
    expect(checkWildcardResourceEnumerable(ctx)).toHaveLength(0);
  });

  test("intrinsic edge (Fn::ImportValue in a consumer) is quiet", () => {
    const ctx = makeCtx({
      Resources: {
        DataBucket: BUCKET,
        AppRole: role({ Effect: "Allow", Action: "s3:GetObject", Resource: "*" }),
        AppFunc: lambda({
          BUCKET_NAME: { Ref: "DataBucket" },
          SHARED_BUCKET: { "Fn::ImportValue": "shared-bucket-name" },
        }),
      },
    });
    expect(checkWildcardResourceEnumerable(ctx)).toHaveLength(0);
  });

  test("statement with a Condition is quiet", () => {
    const ctx = makeCtx({
      Resources: {
        DataBucket: BUCKET,
        AppRole: role({
          Effect: "Allow",
          Action: "s3:GetObject",
          Resource: "*",
          Condition: { StringEquals: { "aws:PrincipalOrgID": "o-abc123" } },
        }),
        AppFunc: lambda({ BUCKET_NAME: { Ref: "DataBucket" } }),
      },
    });
    expect(checkWildcardResourceEnumerable(ctx)).toHaveLength(0);
  });

  test("action outside the curated table is quiet", () => {
    const ctx = makeCtx({
      Resources: {
        DataBucket: BUCKET,
        AppRole: role({
          Effect: "Allow",
          Action: ["ec2:DescribeInstances", "elasticloadbalancing:DescribeTargetGroups"],
          Resource: "*",
        }),
        AppFunc: lambda({ BUCKET_NAME: { Ref: "DataBucket" } }),
      },
    });
    expect(checkWildcardResourceEnumerable(ctx)).toHaveLength(0);
  });

  test("action needing '*' in a curated service is quiet (not in the table)", () => {
    const ctx = makeCtx({
      Resources: {
        DataBucket: BUCKET,
        AppRole: role({ Effect: "Allow", Action: "s3:ListAllMyBuckets", Resource: "*" }),
        AppFunc: lambda({ BUCKET_NAME: { Ref: "DataBucket" } }),
      },
    });
    expect(checkWildcardResourceEnumerable(ctx)).toHaveLength(0);
  });

  test("role with no consumers is quiet", () => {
    const ctx = makeCtx({
      Resources: {
        DataBucket: BUCKET,
        AppRole: role({ Effect: "Allow", Action: "s3:GetObject", Resource: "*" }),
      },
    });
    expect(checkWildcardResourceEnumerable(ctx)).toHaveLength(0);
  });

  test("consumers that touch no declared resource of the service are quiet", () => {
    const ctx = makeCtx({
      Resources: {
        AppRole: role({ Effect: "Allow", Action: "s3:GetObject", Resource: "*" }),
        AppFunc: lambda({ STAGE: "prod" }),
      },
    });
    expect(checkWildcardResourceEnumerable(ctx)).toHaveLength(0);
  });

  test("trust policy statements never fire (Principal gate)", () => {
    const ctx = makeCtx({
      Resources: {
        DataBucket: BUCKET,
        AppRole: { Type: "AWS::IAM::Role", Properties: { AssumeRolePolicyDocument: TRUST } },
        AppFunc: lambda({ BUCKET_NAME: { Ref: "DataBucket" } }),
      },
    });
    expect(checkWildcardResourceEnumerable(ctx)).toHaveLength(0);
  });

  test("policy attached to users or literal role names is quiet", () => {
    const ctx = makeCtx({
      Resources: {
        DataBucket: BUCKET,
        UserPolicy: {
          Type: "AWS::IAM::Policy",
          Properties: {
            PolicyName: "u",
            Users: ["alice"],
            PolicyDocument: {
              Version: "2012-10-17",
              Statement: [{ Effect: "Allow", Action: "s3:GetObject", Resource: "*" }],
            },
          },
        },
        NamePolicy: {
          Type: "AWS::IAM::Policy",
          Properties: {
            PolicyName: "n",
            Roles: ["pre-existing-role-name"],
            PolicyDocument: {
              Version: "2012-10-17",
              Statement: [{ Effect: "Allow", Action: "s3:GetObject", Resource: "*" }],
            },
          },
        },
      },
    });
    expect(checkWildcardResourceEnumerable(ctx)).toHaveLength(0);
  });

  test("managed policy attached from the role side via ManagedPolicyArns fires", () => {
    const ctx = makeCtx({
      Resources: {
        Jobs: TABLE,
        AppManaged: {
          Type: "AWS::IAM::ManagedPolicy",
          Properties: {
            PolicyDocument: {
              Version: "2012-10-17",
              Statement: [{ Effect: "Allow", Action: "dynamodb:PutItem", Resource: "*" }],
            },
          },
        },
        AppRole: {
          Type: "AWS::IAM::Role",
          Properties: {
            AssumeRolePolicyDocument: TRUST,
            ManagedPolicyArns: [{ Ref: "AppManaged" }],
          },
        },
        AppFunc: lambda({ TABLE_NAME: { Ref: "Jobs" } }),
      },
    });
    const diags = checkWildcardResourceEnumerable(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].entity).toBe("AppManaged");
  });

  test("mixed wildcard and concrete Resource entries are quiet (partially scoped)", () => {
    const ctx = makeCtx({
      Resources: {
        DataBucket: BUCKET,
        AppRole: role({
          Effect: "Allow",
          Action: "s3:GetObject",
          Resource: ["arn:aws:s3:::some-bucket/*", "*"],
        }),
        AppFunc: lambda({ BUCKET_NAME: { Ref: "DataBucket" } }),
      },
    });
    expect(checkWildcardResourceEnumerable(ctx)).toHaveLength(0);
  });
});
