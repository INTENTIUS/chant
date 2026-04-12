import { describe, it, expect, beforeAll } from "vitest";
import { promisify } from "util";
import { exec } from "child_process";
import { dynamo, mc, solrCount, retry, SOLR } from "./test-helpers";

const execAsync = promisify(exec);
function $(strings: TemplateStringsArray, ...values: unknown[]) {
  const parts: string[] = [];
  strings.forEach((str, i) => {
    parts.push(str);
    if (i < values.length) {
      const val = values[i];
      parts.push(Array.isArray(val) ? (val as string[]).join(" ") : String(val ?? ""));
    }
  });
  return execAsync(parts.join(""));
}

// These tests require `just up` to be running. Skip in CI.
if (process.env.CI) process.exit(0);

const N_DYNAMO = 25;
const N_S3     = 10;

beforeAll(async () => {
  // Idempotent: ignore error if table already exists
  await dynamo(
    "create-table", "--table-name", "products",
    "--attribute-definitions", "AttributeName=id,AttributeType=S",
    "--key-schema", "AttributeName=id,KeyType=HASH",
    "--billing-mode", "PAY_PER_REQUEST",
    "--stream-specification", "StreamEnabled=true,StreamViewType=NEW_AND_OLD_IMAGES",
  ).catch(() => {});
  await mc("mb", "--ignore-existing", "local/documents");
}, 15_000);

describe("Solr", () => {
  it("admin UI is reachable", async () => {
    const r = await fetch(`${SOLR}/admin/luke?wt=json`);
    expect(r.ok).toBe(true);
  });
});

describe("DynamoDB relay volume", () => {
  it(`indexes ${N_DYNAMO} items inserted in parallel`, async () => {
    const ids = Array.from({ length: N_DYNAMO }, (_, i) => `vol-dynamo-${i}`);
    await Promise.all(ids.map(id =>
      dynamo("put-item", "--table-name", "products",
        "--item", JSON.stringify({ id: { S: id }, title: { S: `Volume Item ${id}` } }))
    ));
    await retry(30, "1s", async () => {
      const count = await solrCount(`id:(${ids.map(id => `"${id}"`).join(" OR ")})`);
      expect(count).toBe(N_DYNAMO);
    });
  }, 60_000);
});

describe("MinIO relay volume", () => {
  it(`indexes ${N_S3} objects uploaded in parallel`, async () => {
    const keys = Array.from({ length: N_S3 }, (_, i) => `data/vol-s3-${i}.txt`);
    await Promise.all(keys.map((key, i) =>
      $`echo ${`content-${i}`} | AWS_ACCESS_KEY_ID=minioadmin AWS_SECRET_ACCESS_KEY=minioadmin aws s3 cp - s3://documents/${key} --endpoint-url http://localhost:9000 --region us-east-1`
    ));
    await retry(30, "2s", async () => {
      const count = await solrCount(`id:(${keys.map(k => `"${k}"`).join(" OR ")})`);
      expect(count).toBe(N_S3);
    });
  }, 90_000);
});
