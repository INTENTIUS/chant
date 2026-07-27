// CDK side of the matched pair. Plain CommonJS JavaScript, deliberately: no ts-node or
// bundler frames muddy the capture — what executes is this file and aws-cdk-lib, which
// is exactly the point being measured. Same infrastructure as ../chant-app/src:
// items table + CRUD Lambda + HTTP API (4 routes) + the IAM the grant implies.
const cdk = require('aws-cdk-lib');
const dynamodb = require('aws-cdk-lib/aws-dynamodb');
const lambda = require('aws-cdk-lib/aws-lambda');
const apigwv2 = require('aws-cdk-lib/aws-apigatewayv2');
const integrations = require('aws-cdk-lib/aws-apigatewayv2-integrations');

const HANDLER = `const { DynamoDBClient, GetItemCommand, PutItemCommand, DeleteItemCommand } = require("@aws-sdk/client-dynamodb");
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
};`;

class ItemsStack extends cdk.Stack {
  constructor(scope, id, props) {
    super(scope, id, props);

    const table = new dynamodb.Table(this, 'ItemsTable', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    });

    const fn = new lambda.Function(this, 'CrudFn', {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline(HANDLER),
      environment: { TABLE_NAME: table.tableName },
    });
    table.grantReadWriteData(fn);

    const api = new apigwv2.HttpApi(this, 'ItemsApi');
    const integration = new integrations.HttpLambdaIntegration('CrudIntegration', fn);
    api.addRoutes({ path: '/items/{id}', methods: [apigwv2.HttpMethod.GET], integration });
    api.addRoutes({ path: '/items', methods: [apigwv2.HttpMethod.POST], integration });
    api.addRoutes({ path: '/items/{id}', methods: [apigwv2.HttpMethod.PUT], integration });
    api.addRoutes({ path: '/items/{id}', methods: [apigwv2.HttpMethod.DELETE], integration });

    new cdk.CfnOutput(this, 'ApiEndpoint', { value: api.apiEndpoint });
    new cdk.CfnOutput(this, 'TableArn', { value: table.tableArn });
  }
}

const app = new cdk.App();
new ItemsStack(app, 'leftness-items');
