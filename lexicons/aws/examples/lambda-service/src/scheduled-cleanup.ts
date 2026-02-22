import { Sub, AWS, Role_Policy, ScheduledLambda, DynamoDBActions } from "@intentius/chant-lexicon-aws";
import { dataTable } from "./data-table";

export const cleanupPolicyDocument = {
  Version: "2012-10-17",
  Statement: [
    {
      Effect: "Allow",
      Action: DynamoDBActions.ReadWrite,
      Resource: dataTable.Arn,
    },
  ],
};

export const cleanupPolicy = new Role_Policy({
  PolicyName: "DynamoDBCleanup",
  PolicyDocument: cleanupPolicyDocument,
});

// ScheduledLambda: Role + Function + EventBridge Rule + Permission
export const cleanup = ScheduledLambda({
  name: Sub`${AWS.StackName}-cleanup`,
  Runtime: "python3.12",
  Handler: "handler.handler",
  Code: {
    ZipFile: `import boto3, os
def handler(event, context):
    table = boto3.resource("dynamodb").Table(os.environ["TABLE_NAME"])
    # Scan for expired items and delete them
    return {"statusCode": 200}`,
  },
  schedule: "rate(1 day)",
  Environment: { Variables: { TABLE_NAME: dataTable.Arn } },
  Policies: [cleanupPolicy],
});
