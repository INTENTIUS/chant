import {
  LambdaDynamoDB,
  LambdaS3,
  LogGroup,
  Sub,
  Ref,
  AWS,
} from "@intentius/chant-lexicon-aws";
import { appName, solrUrl, solrCollection } from "./params";

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

export const {
  table: productsTable,
  role: productsRelayRole,
  func: productsRelayFn,
  eventSourceMapping: productsEsm,
} = LambdaDynamoDB({
  name: Sub`${AWS.StackName}-${Ref(appName)}-products-relay`,
  partitionKey: "id",
  tableName: Sub`${AWS.StackName}-${Ref(appName)}-products`,
  access: "None",
  streams: { startingPosition: "TRIM_HORIZON", bisectOnFunctionError: true },
  Runtime: "python3.12",
  Handler: "index.handler",
  Code: { ZipFile: dynamoRelayCode },
  Timeout: 30,
  Environment: { Variables: { SOLR_URL: solrUrl, COLLECTION: solrCollection } },
});

export const productsRelayLogGroup = new LogGroup({
  LogGroupName: Sub`/aws/lambda/${AWS.StackName}-${Ref(appName)}-products-relay`,
  RetentionInDays: 30,
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

export const {
  bucket: documentsBucket,
  role: documentsRelayRole,
  func: documentsRelayFn,
  permission: documentsRelayPermission,
} = LambdaS3({
  name: Sub`${AWS.StackName}-${Ref(appName)}-documents-relay`,
  bucketName: Sub`${AWS.StackName}-${Ref(appName)}-documents`,
  access: "ReadOnly",
  trigger: { prefix: "data/" },
  Runtime: "python3.12",
  Handler: "index.handler",
  Code: { ZipFile: s3RelayCode },
  Timeout: 30,
  Environment: { Variables: { SOLR_URL: solrUrl, COLLECTION: solrCollection } },
});

export const documentsRelayLogGroup = new LogGroup({
  LogGroupName: Sub`/aws/lambda/${AWS.StackName}-${Ref(appName)}-documents-relay`,
  RetentionInDays: 30,
});
