/**
 * Replacing an S3Queue table against the pinned server (#4396): a change to
 * the table's settings is planned as SQLCH225, the apply detaches the view,
 * drops and creates the table and attaches the view, and the view keeps
 * feeding the target with no file processed twice. A different keeper_path
 * plans with the reprocessing warning.
 *
 * Needs Docker; skips cleanly without it. A one-server cluster (its embedded
 * Keeper is what S3Queue records processed files in) and a MinIO container on
 * its network as the object store, both removed afterwards even on failure.
 * The credentials are MinIO's published test values, held in a named
 * collection on the server (#4395) and never in the declaration.
 */

import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { expandComposite } from "@intentius/chant/composite";
import type { Declarable } from "@intentius/chant/declarable";
import type { SerializerResult } from "@intentius/chant/serializer";
import { dockerAvailable, startScratchCluster, type ScratchCluster } from "../container";
import { clickhouseQuery } from "../http";
import { clickhouseImage } from "../../spec/pin";
import { sqlSerializer } from "../../serializer";
import { StreamIngest } from "../../composites";
import { bindClickHouse } from "../live/bind";
import { applyClickHouse, declaredObjects } from "../apply/apply";
import { planAgainstServer } from "./commands";
import { renderDiff } from "./report";

const exec = promisify(execFile);
const enabled = await dockerAvailable();
let cluster: ScratchCluster | undefined;
let minio: string | undefined;
const dir = mkdtempSync(join(tmpdir(), "chant-sql-s3queue-"));
const buildFile = join(dir, "files.json");

const MINIO_IMAGE = "minio/minio:RELEASE.2025-04-22T22-12-26Z";
const q = <T = unknown>(sql: string) => clickhouseQuery<T>(cluster!.replicas[0]!, sql);
const env = () => ({ config: {}, env: { CLICKHOUSE_URL: cluster!.replicas[0]!.url } });

beforeAll(async () => {
  if (!enabled) return;
  cluster = await startScratchCluster(clickhouseImage(), { replicas: 1, namePrefix: "chant-sql-s3queue" });
  minio = `${cluster.name}-minio`;
  await exec("docker", [
    "run", "-d", "--name", minio, "--network", `${cluster.name}-net`,
    "-e", "MINIO_ROOT_USER=minioadmin", "-e", "MINIO_ROOT_PASSWORD=minioadmin",
    MINIO_IMAGE, "server", "/data",
  ], { timeout: 600_000 });
  await exec("docker", ["exec", minio, "mkdir", "-p", "/data/lake"]);
  await q(`CREATE NAMED COLLECTION lake_creds AS url = 'http://${minio}:9000/lake/in/*.csv', access_key_id = 'minioadmin', secret_access_key = 'minioadmin'`);
  await q("CREATE DATABASE shop");
}, 900_000);

afterAll(async () => {
  if (minio) await exec("docker", ["rm", "-f", minio]).catch(() => undefined);
  await cluster?.stop();
  rmSync(dir, { recursive: true, force: true });
});

/** The ingest chain with the S3Queue table's settings as given. */
function buildOf(settings: string): string {
  const entities = new Map<string, Declarable>();
  for (const [k, v] of expandComposite(
    "files",
    StreamIngest({
      name: "shop.files",
      columns: "id UInt64, v String",
      engine: "S3Queue(lake_creds, format = 'CSV')",
      settings,
      orderBy: "id",
    }),
  )) {
    entities.set(k, v);
  }
  return (sqlSerializer.serialize(entities) as SerializerResult).primary;
}

const SETTINGS = (maxMs: number, path = "/chant/e2e/files") =>
  `mode = 'unordered', keeper_path = '${path}', s3queue_polling_min_timeout_ms = 100, s3queue_polling_max_timeout_ms = ${maxMs}`;

async function putFile(name: string, rows: string): Promise<void> {
  await q(`INSERT INTO FUNCTION s3('http://${minio}:9000/lake/in/${name}', 'minioadmin', 'minioadmin', 'CSV', 'id UInt64, v String') VALUES ${rows}`);
}

async function waitForRows(n: number): Promise<void> {
  const deadline = Date.now() + 90_000;
  for (;;) {
    const [row] = await q<{ n: string }>("SELECT count() AS n FROM shop.files");
    if (Number(row?.n) >= n) return;
    if (Date.now() > deadline) throw new Error(`shop.files held ${row?.n} rows, wanted ${n}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function apply(json: string) {
  const target = await bindClickHouse({ environment: "e2e", ...env() });
  return applyClickHouse(target, declaredObjects(json, "default", target.topology));
}

describe.skipIf(!enabled)("replacing an S3Queue table", () => {
  test("the view keeps feeding the target, and no file is processed twice", async () => {
    await apply(buildOf(SETTINGS(500)));
    await putFile("f1.csv", "(1, 'a'), (2, 'b')");
    await putFile("f2.csv", "(3, 'c')");
    await waitForRows(3);
    const [before] = await q<{ uuid: string }>("SELECT toString(uuid) AS uuid FROM system.tables WHERE database = 'shop' AND name = 'files_stream'");

    // The settings change: planned as a stream-table replacement, not a rebuild, with nothing refused.
    const next = buildOf(SETTINGS(1000));
    writeFileSync(buildFile, next);
    const diff = await planAgainstServer("e2e", buildFile, env());
    expect(diff.changes.map((c) => [c.rule, c.field])).toEqual([["SQLCH225", "settings.s3queue_polling_max_timeout_ms"]]);
    expect(diff.rebuilds).toEqual([]);
    expect(diff.changes[0]!.note).toBeUndefined();
    expect(diff.hints.join("\n")).toMatch(/shop\.files_stream is replaced: shop\.files_mv reads it/);

    const outcome = await apply(next);
    expect(outcome.failed).toEqual([]);
    const replaced = outcome.applied.find((a) => a.name === "shop.files_stream");
    expect(replaced?.statements.map((s) => s.split(" ").slice(0, 2).join(" "))).toEqual(["DETACH TABLE", "DROP TABLE", "CREATE TABLE", "ATTACH TABLE"]);

    const [after] = await q<{ uuid: string }>("SELECT toString(uuid) AS uuid FROM system.tables WHERE database = 'shop' AND name = 'files_stream'");
    expect(after!.uuid).not.toBe(before!.uuid);
    const [view] = await q<{ n: string }>("SELECT count() AS n FROM system.tables WHERE database = 'shop' AND name = 'files_mv'");
    expect(Number(view!.n)).toBe(1);

    // A file that lands after the replacement is read by the new table through the same view.
    await putFile("f3.csv", "(4, 'd'), (5, 'e')");
    await waitForRows(5);
    // Give the new table the chance to read f1 and f2 again, which it must not.
    await new Promise((r) => setTimeout(r, 5000));
    const [rows] = await q<{ n: string; distinct: string }>("SELECT count() AS n, uniqExact(id) AS distinct FROM shop.files");
    expect([Number(rows!.n), Number(rows!.distinct)]).toEqual([5, 5]);
    expect((await planAgainstServer("e2e", buildFile, env())).changes).toEqual([]);
  }, 300_000);

  test("a different keeper_path plans with the reprocessing warning", async () => {
    writeFileSync(buildFile, buildOf(SETTINGS(1000, "/chant/e2e/files-v2")));
    const diff = await planAgainstServer("e2e", buildFile, env());
    expect(diff.changes.map((c) => [c.rule, c.field])).toEqual([["SQLCH225", "settings.keeper_path"]]);
    expect(renderDiff(diff)).toMatch(/every file already seen is processed again/);
  }, 120_000);
});
