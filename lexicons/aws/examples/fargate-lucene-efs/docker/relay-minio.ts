import { S3Client, ListObjectsV2Command, GetObjectCommand } from "@aws-sdk/client-s3";

const MINIO_ENDPOINT = process.env.MINIO_ENDPOINT!;
const MINIO_ACCESS_KEY = process.env.MINIO_ACCESS_KEY ?? "minioadmin";
const MINIO_SECRET_KEY = process.env.MINIO_SECRET_KEY ?? "minioadmin";
const MINIO_BUCKET = process.env.MINIO_BUCKET ?? "documents";
const MINIO_PREFIX = process.env.MINIO_PREFIX ?? "data/";
const SOLR_URL = process.env.SOLR_URL!;
const COLLECTION = process.env.COLLECTION!;
const POLL_INTERVAL = parseFloat(process.env.POLL_INTERVAL ?? "2") * 1000;

const s3 = new S3Client({
  endpoint: MINIO_ENDPOINT,
  region: "us-east-1",
  credentials: { accessKeyId: MINIO_ACCESS_KEY, secretAccessKey: MINIO_SECRET_KEY },
  forcePathStyle: true,
});

async function solrPost(path: string, data: unknown): Promise<void> {
  const url = `${SOLR_URL}/${COLLECTION}/${path}?commit=true`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`Solr ${path} failed: ${res.status}`);
}

async function listObjects(): Promise<string[]> {
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const resp = await s3.send(new ListObjectsV2Command({
      Bucket: MINIO_BUCKET,
      Prefix: MINIO_PREFIX,
      ContinuationToken: token,
    }));
    for (const obj of resp.Contents ?? []) {
      if (obj.Key) keys.push(obj.Key);
    }
    token = resp.NextContinuationToken;
  } while (token);
  return keys;
}

async function indexObject(key: string): Promise<void> {
  const resp = await s3.send(new GetObjectCommand({ Bucket: MINIO_BUCKET, Key: key }));
  const content = await resp.Body!.transformToString("utf-8");
  await solrPost("update/json/docs", [{ id: key, content }]);
  console.log(`indexed s3://${MINIO_BUCKET}/${key} (${content.length} bytes)`);
}

async function main(): Promise<void> {
  console.log(`relay polling s3://${MINIO_BUCKET}/${MINIO_PREFIX} every ${POLL_INTERVAL / 1000}s …`);
  const indexed = new Set<string>();

  while (true) {
    try {
      const keys = await listObjects();
      const newKeys = keys.filter(k => !indexed.has(k));
      for (const key of newKeys) {
        try {
          await indexObject(key);
          indexed.add(key);
        } catch (e) {
          console.warn(`failed to index ${key}: ${e}`);
        }
      }
    } catch (e) {
      console.warn(`poll error: ${e}`);
    }
    await new Promise(r => setTimeout(r, POLL_INTERVAL));
  }
}

main().catch(err => { console.error(err); process.exit(1); });
