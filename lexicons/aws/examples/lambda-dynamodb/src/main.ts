import { LambdaDynamoDB, Sub, AWS } from "@intentius/chant-lexicon-aws";

export const app = LambdaDynamoDB({
  name: Sub`${AWS.StackName}-fn`,
  tableName: Sub`${AWS.StackName}-table`,
  Runtime: "nodejs20.x",
  Handler: "index.handler",
  Code: {
    ZipFile: `const { DynamoDBClient, PutItemCommand, GetItemCommand } = require("@aws-sdk/client-dynamodb");
const db = new DynamoDBClient();

exports.handler = async (event) => {
  const { httpMethod, body, queryStringParameters } = event;

  if (httpMethod === "POST") {
    const item = JSON.parse(body);
    await db.send(new PutItemCommand({
      TableName: process.env.TABLE_NAME,
      Item: { pk: { S: item.id }, data: { S: JSON.stringify(item) } },
    }));
    return { statusCode: 201, body: JSON.stringify({ id: item.id }) };
  }

  const id = queryStringParameters?.id;
  const result = await db.send(new GetItemCommand({
    TableName: process.env.TABLE_NAME,
    Key: { pk: { S: id } },
  }));
  return {
    statusCode: result.Item ? 200 : 404,
    body: JSON.stringify(result.Item ? JSON.parse(result.Item.data.S) : { error: "Not found" }),
  };
};`,
  },
  partitionKey: "pk",
  access: "ReadWrite",
});
