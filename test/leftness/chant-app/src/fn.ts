import { Function, Role, Sub, AWS } from "@intentius/chant-lexicon-aws";
import { itemsTable } from "./table";

// What CDK's table.grantReadWriteData(fn) implies, declared explicitly: an execution
// role scoped to the one table, and the CRUD handler wired to it.
export const crudRole = new Role({
  AssumeRolePolicyDocument: {
    Version: "2012-10-17",
    Statement: [{ Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" }],
  },
  ManagedPolicyArns: ["arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"],
  Policies: [
    {
      PolicyName: "items-crud",
      PolicyDocument: {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Action: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:Query"],
            Resource: itemsTable.Arn,
          },
        ],
      },
    },
  ],
});

export const crudFn = new Function({
  FunctionName: Sub`${AWS.StackName}-crud`,
  Runtime: "nodejs24.x",
  Handler: "index.handler",
  Role: crudRole.Arn,
  Environment: { Variables: { TABLE_NAME: Sub`${AWS.StackName}-items` } },
  Code: {
    ZipFile: `const { DynamoDBClient, GetItemCommand, PutItemCommand, DeleteItemCommand } = require("@aws-sdk/client-dynamodb");
const db = new DynamoDBClient();
exports.handler = async (event) => {
  const method = event.requestContext?.http?.method;
  const id = event.pathParameters?.id ?? JSON.parse(event.body ?? "{}").id;
  const T = process.env.TABLE_NAME;
  if (method === "POST" || method === "PUT") {
    await db.send(new PutItemCommand({ TableName: T, Item: { pk: { S: id }, data: { S: event.body } } }));
    return { statusCode: method === "POST" ? 201 : 200, body: JSON.stringify({ id }) };
  }
  if (method === "DELETE") {
    await db.send(new DeleteItemCommand({ TableName: T, Key: { pk: { S: id } } }));
    return { statusCode: 204 };
  }
  const r = await db.send(new GetItemCommand({ TableName: T, Key: { pk: { S: id } } }));
  return { statusCode: r.Item ? 200 : 404, body: r.Item ? r.Item.data.S : JSON.stringify({ error: "not found" }) };
};`,
  },
});
