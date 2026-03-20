import {
  Table,
  Table_AttributeDefinition,
  Table_KeySchema,
  Table_StreamSpecification,
  Role,
  Role_Policy,
  LogGroup,
  Function,
  EventSourceMapping,
  Bucket,
  Bucket_BucketEncryption,
  Bucket_ServerSideEncryptionRule,
  Bucket_ServerSideEncryptionByDefault,
  Bucket_PublicAccessBlockConfiguration,
  Bucket_NotificationConfiguration,
  Bucket_LambdaConfiguration,
  Permission,
  Sub,
  Ref,
  AWS,
} from "@intentius/chant-lexicon-aws";
import { appName, solrUrl, solrCollection } from "./params";

const lambdaTrustPolicy = {
  Version: "2012-10-17" as const,
  Statement: [
    {
      Effect: "Allow" as const,
      Principal: { Service: "lambda.amazonaws.com" },
      Action: "sts:AssumeRole",
    },
  ],
};

// ── DynamoDB → Solr relay (products) ────────────────────────────────────────

const dynamoRelayCode = `
import json, urllib.request, os
def handler(event, context):
    docs = []
    for r in event['Records']:
        if r['eventName'] in ('INSERT', 'MODIFY'):
            img = r['dynamodb']['NewImage']
            docs.append({f: list(v.values())[0] for f, v in img.items()})
        elif r['eventName'] == 'REMOVE':
            pk = list(r['dynamodb']['Keys']['id'].values())[0]
            req = urllib.request.Request(
                f"{os.environ['SOLR_URL']}/{os.environ['COLLECTION']}/update?commit=true",
                data=json.dumps({'delete': {'id': pk}}).encode(),
                headers={'Content-Type': 'application/json'}, method='POST')
            urllib.request.urlopen(req)
            continue
    if docs:
        req = urllib.request.Request(
            f"{os.environ['SOLR_URL']}/{os.environ['COLLECTION']}/update/json/docs?commit=true",
            data=json.dumps(docs).encode(),
            headers={'Content-Type': 'application/json'}, method='POST')
        urllib.request.urlopen(req)
`.trimStart();

export const productsTable = new Table({
  TableName: Sub`${AWS.StackName}-${Ref(appName)}-products`,
  BillingMode: "PAY_PER_REQUEST",
  AttributeDefinitions: [
    new Table_AttributeDefinition({ AttributeName: "id", AttributeType: "S" }),
  ],
  KeySchema: [new Table_KeySchema({ AttributeName: "id", KeyType: "HASH" })],
  StreamSpecification: new Table_StreamSpecification({
    StreamViewType: "NEW_AND_OLD_IMAGES",
  }),
});

const productsRelayStreamPolicy = new Role_Policy({
  PolicyName: "StreamRead",
  PolicyDocument: {
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Action: [
          "dynamodb:GetRecords",
          "dynamodb:GetShardIterator",
          "dynamodb:DescribeStream",
          "dynamodb:ListStreams",
        ],
        Resource: productsTable.StreamArn,
      },
    ],
  },
});

export const productsRelayRole = new Role({
  RoleName: Sub`${AWS.StackName}-${Ref(appName)}-products-relay-role`,
  AssumeRolePolicyDocument: lambdaTrustPolicy,
  ManagedPolicyArns: [
    "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
  ],
  Policies: [productsRelayStreamPolicy],
});

export const productsRelayLogGroup = new LogGroup({
  LogGroupName: Sub`/aws/lambda/${AWS.StackName}-${Ref(appName)}-products-relay`,
  RetentionInDays: 30,
});

export const productsRelayFn = new Function({
  FunctionName: Sub`${AWS.StackName}-${Ref(appName)}-products-relay`,
  Runtime: "python3.12",
  Handler: "index.handler",
  Role: productsRelayRole.Arn,
  Code: { ZipFile: dynamoRelayCode },
  Timeout: 30,
  Environment: {
    Variables: {
      SOLR_URL: solrUrl,
      COLLECTION: solrCollection,
    },
  },
});

export const productsEsm = new EventSourceMapping({
  FunctionName: productsRelayFn.Arn,
  EventSourceArn: productsTable.StreamArn,
  StartingPosition: "TRIM_HORIZON",
  BisectBatchOnFunctionError: true,
});

// ── S3 → Solr relay (documents) ─────────────────────────────────────────────

const s3RelayCode = `
import json, urllib.request, os, boto3
def handler(event, context):
    s3 = boto3.client('s3')
    for r in event['Records']:
        bucket = r['s3']['bucket']['name']
        key = r['s3']['object']['key']
        obj = s3.get_object(Bucket=bucket, Key=key)
        content = obj['Body'].read().decode('utf-8')
        doc = {'id': key, 'content': content}
        req = urllib.request.Request(
            f"{os.environ['SOLR_URL']}/{os.environ['COLLECTION']}/update/json/docs?commit=true",
            data=json.dumps([doc]).encode(),
            headers={'Content-Type': 'application/json'}, method='POST')
        urllib.request.urlopen(req)
`.trimStart();

export const documentsRelayRole = new Role({
  RoleName: Sub`${AWS.StackName}-${Ref(appName)}-documents-relay-role`,
  AssumeRolePolicyDocument: lambdaTrustPolicy,
  ManagedPolicyArns: [
    "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
  ],
  Policies: [
    new Role_Policy({
      PolicyName: "S3Read",
      PolicyDocument: {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Action: ["s3:GetObject"],
            Resource: Sub`arn:aws:s3:::${AWS.StackName}-${Ref(appName)}-documents/*`,
          },
        ],
      },
    }),
  ],
});

export const documentsRelayLogGroup = new LogGroup({
  LogGroupName: Sub`/aws/lambda/${AWS.StackName}-${Ref(appName)}-documents-relay`,
  RetentionInDays: 30,
});

export const documentsRelayFn = new Function({
  FunctionName: Sub`${AWS.StackName}-${Ref(appName)}-documents-relay`,
  Runtime: "python3.12",
  Handler: "index.handler",
  Role: documentsRelayRole.Arn,
  Code: { ZipFile: s3RelayCode },
  Timeout: 30,
  Environment: {
    Variables: {
      SOLR_URL: solrUrl,
      COLLECTION: solrCollection,
    },
  },
});

const encryptionDefault = new Bucket_ServerSideEncryptionByDefault({
  SSEAlgorithm: "AES256",
});

const encryptionRule = new Bucket_ServerSideEncryptionRule({
  ServerSideEncryptionByDefault: encryptionDefault,
});

const bucketEncryption = new Bucket_BucketEncryption({
  ServerSideEncryptionConfiguration: [encryptionRule],
});

const publicAccessBlock = new Bucket_PublicAccessBlockConfiguration({
  BlockPublicAcls: true,
  BlockPublicPolicy: true,
  IgnorePublicAcls: true,
  RestrictPublicBuckets: true,
});

const lambdaNotification = new Bucket_LambdaConfiguration({
  Event: "s3:ObjectCreated:*",
  Filter: { S3Key: { Rules: [{ Name: "prefix", Value: "data/" }] } },
  Function: documentsRelayFn.Arn,
});

const notificationConfig = new Bucket_NotificationConfiguration({
  LambdaConfigurations: [lambdaNotification],
});

export const documentsBucket = new Bucket({
  BucketName: Sub`${AWS.StackName}-${Ref(appName)}-documents`,
  BucketEncryption: bucketEncryption,
  PublicAccessBlockConfiguration: publicAccessBlock,
  NotificationConfiguration: notificationConfig,
});

export const documentsRelayPermission = new Permission({
  FunctionName: documentsRelayFn.Arn,
  Action: "lambda:InvokeFunction",
  Principal: "s3.amazonaws.com",
  SourceArn: documentsBucket.Arn,
});
