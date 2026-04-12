import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promisify } from "util";
import { exec } from "child_process";
import { compose, dynamo, mc, solrCount, retry, SOLR } from "./test-helpers";

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
  await compose("down", "-v").catch(() => {});
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
