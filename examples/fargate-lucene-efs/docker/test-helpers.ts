import { promisify } from "util";
import { exec } from "child_process";

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

export const SOLR = "http://localhost:8983/solr/lucene";

export const compose = (...args: string[]) =>
  $`docker compose -f dist/docker-compose.yml --project-name lucene-solr ${args}`;

export const dynamo = (...args: string[]) =>
  $`aws dynamodb --endpoint-url http://localhost:8000 --region us-east-1 --no-cli-pager ${args}`;

export const mc = (...args: string[]) =>
  $`docker run --rm --network lucene-solr_solrNet -e MC_HOST_local=http://minioadmin:minioadmin@minio:9000 minio/mc:latest ${args}`;

export async function solrCount(q: string): Promise<number> {
  const r = await fetch(`${SOLR}/select?q=${encodeURIComponent(q)}&wt=json`).then(r => r.json()) as any;
  return r.response.numFound;
}

export async function retry(times: number, interval: string, fn: () => Promise<void>): Promise<void> {
  const ms = parseInt(interval) * (interval.endsWith("s") ? 1000 : 1);
  for (let i = 0; i < times; i++) {
    try { await fn(); return; } catch (e) {
      if (i === times - 1) throw e;
      await new Promise<void>(r => setTimeout(r, ms));
    }
  }
}
