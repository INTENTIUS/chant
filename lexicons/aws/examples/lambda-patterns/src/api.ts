import { Sub, AWS, Role_Policy, LambdaApi, DynamoDBActions } from "@intentius/chant-lexicon-aws";
import { dataTable } from "./data-table";

// LambdaApi: Role + Function + Permission (API Gateway invocation)
export const api = LambdaApi({
  name: Sub`${AWS.StackName}-api`,
  Runtime: "nodejs20.x",
  Handler: "index.handler",
  Code: {
    ZipFile: `exports.handler = async (event) => {
      return { statusCode: 200, body: JSON.stringify({ items: [] }) };
    };`,
  },
  Timeout: 10,
  Environment: { Variables: { TABLE_NAME: dataTable.Arn } },
  Policies: [
    new Role_Policy({
      PolicyName: "DynamoDBReadWrite",
      PolicyDocument: {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Action: DynamoDBActions.ReadWrite,
            Resource: dataTable.Arn,
          },
        ],
      },
    }),
  ],
});
