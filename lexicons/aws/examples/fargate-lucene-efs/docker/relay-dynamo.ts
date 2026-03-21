import { DynamoDBClient, DescribeTableCommand } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBStreamsClient,
  DescribeStreamCommand,
  GetShardIteratorCommand,
  GetRecordsCommand,
  type _Record,
} from "@aws-sdk/client-dynamodb-streams";

const DYNAMO_ENDPOINT = process.env.DYNAMO_ENDPOINT!;
const DYNAMO_TABLE = process.env.DYNAMO_TABLE ?? "products";
const SOLR_URL = process.env.SOLR_URL!;
const COLLECTION = process.env.COLLECTION!;
const POLL_INTERVAL = parseFloat(process.env.POLL_INTERVAL ?? "1") * 1000;

const clientConfig = {
  endpoint: DYNAMO_ENDPOINT,
  region: "us-east-1",
  credentials: { accessKeyId: "local", secretAccessKey: "local" },
};

const dynamo = new DynamoDBClient(clientConfig);
const streams = new DynamoDBStreamsClient(clientConfig);

async function solrPost(path: string, data: unknown): Promise<void> {
  const url = `${SOLR_URL}/${COLLECTION}/${path}?commit=true`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`Solr ${path} failed: ${res.status}`);
}

async function processRecords(records: _Record[]): Promise<void> {
  const adds: Record<string, string>[] = [];
  for (const r of records) {
    const ev = r.eventName;
    if (ev === "INSERT" || ev === "MODIFY") {
      const img = r.dynamodb!.NewImage!;
      const doc: Record<string, string> = {};
      for (const [field, val] of Object.entries(img)) {
        doc[field] = Object.values(val as unknown as Record<string, string>)[0];
      }
      adds.push(doc);
    } else if (ev === "REMOVE") {
      const pk = Object.values(r.dynamodb!.Keys!.id as unknown as Record<string, string>)[0];
      await solrPost("update", { delete: { id: pk } });
      console.log(`deleted id=${pk}`);
    }
  }
  if (adds.length > 0) {
    await solrPost("update/json/docs", adds);
    console.log(`indexed ${adds.length} doc(s)`);
  }
}

async function main(): Promise<void> {
  console.log(`waiting for table ${DYNAMO_TABLE} …`);
  let streamArn: string | undefined;
  while (!streamArn) {
    try {
      const resp = await dynamo.send(new DescribeTableCommand({ TableName: DYNAMO_TABLE }));
      streamArn = resp.Table?.LatestStreamArn;
    } catch (e) {
      console.warn(`table not ready: ${e}`);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  console.log(`stream ARN: ${streamArn}`);

  const iterators = new Map<string, string | undefined>();

  while (true) {
    const desc = await streams.send(new DescribeStreamCommand({ StreamArn: streamArn }));
    for (const shard of desc.StreamDescription?.Shards ?? []) {
      const sid = shard.ShardId!;
      if (!iterators.has(sid)) {
        const resp = await streams.send(new GetShardIteratorCommand({
          StreamArn: streamArn,
          ShardId: sid,
          ShardIteratorType: "TRIM_HORIZON",
        }));
        iterators.set(sid, resp.ShardIterator);
      }
    }

    for (const [sid, it] of Array.from(iterators)) {
      if (!it) continue;
      try {
        const resp = await streams.send(new GetRecordsCommand({ ShardIterator: it, Limit: 100 }));
        const records = resp.Records ?? [];
        if (records.length > 0) await processRecords(records);
        iterators.set(sid, resp.NextShardIterator);
      } catch (e) {
        console.warn(`shard ${sid} error: ${e}`);
        iterators.set(sid, undefined);
      }
    }

    await new Promise(r => setTimeout(r, POLL_INTERVAL));
  }
}

main().catch(err => { console.error(err); process.exit(1); });
