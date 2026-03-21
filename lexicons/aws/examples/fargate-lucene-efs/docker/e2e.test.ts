import { $ } from "bun";
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { compose, dynamo, mc, solrCount, retry, SOLR } from "./test-helpers";

$.verbose = false;

beforeAll(async () => {
  await $`npm run build`;
  await compose("up", "--build", "-d");

  await retry(30, "2s", () =>
    fetch(`${SOLR}/select?q=*:*`).then(r => { if (!r.ok) throw new Error(`solr ${r.status}`); })
  );
  await retry(30, "2s", () =>
    fetch("http://localhost:9000/minio/health/live").then(r => { if (!r.ok) throw new Error(`minio ${r.status}`); })
  );
  await retry(30, "2s", () => dynamo("list-tables"));

  await mc("mb", "--ignore-existing", "local/documents");
  await dynamo(
    "create-table",
    "--table-name", "products",
    "--attribute-definitions", "AttributeName=id,AttributeType=S",
    "--key-schema", "AttributeName=id,KeyType=HASH",
    "--billing-mode", "PAY_PER_REQUEST",
    "--stream-specification", "StreamEnabled=true,StreamViewType=NEW_AND_OLD_IMAGES",
  );
}, 120_000);

afterAll(async () => {
  await compose("down", "-v").nothrow();
});

describe("DynamoDB relay", () => {
  it("indexes inserted item", async () => {
    await dynamo(
      "put-item", "--table-name", "products",
      "--item", '{"id": {"S": "test-dynamo"}, "title": {"S": "DynamoDB Test Item"}}',
    );
    await retry(10, "1s", async () => {
      expect(await solrCount("id:test-dynamo")).toBeGreaterThanOrEqual(1);
    });
  }, 30_000);

  it("removes deleted item", async () => {
    await dynamo(
      "delete-item", "--table-name", "products",
      "--key", '{"id": {"S": "test-dynamo"}}',
    );
    await retry(10, "1s", async () => {
      expect(await solrCount("id:test-dynamo")).toBe(0);
    });
  }, 30_000);
});

describe("MinIO relay", () => {
  it("indexes uploaded document", async () => {
    await $`echo "hello from minio relay test" | AWS_ACCESS_KEY_ID=minioadmin AWS_SECRET_ACCESS_KEY=minioadmin aws s3 cp - s3://documents/data/test-minio.txt --endpoint-url http://localhost:9000 --region us-east-1`;
    await retry(10, "1s", async () => {
      expect(await solrCount(`id:"data/test-minio.txt"`)).toBeGreaterThanOrEqual(1);
    });
  }, 30_000);
});
