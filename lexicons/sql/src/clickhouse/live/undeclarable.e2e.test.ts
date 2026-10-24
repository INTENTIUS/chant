/**
 * Import against a real ClickHouse server never leaves an object out without
 * a word (#3911): a server holding a workload made with SQL, beside a
 * table, fails the import, which names it; a named collection is the
 * environment's (#4395), listed as a prerequisite and not refused; a quota and a
 * settings profile are declared kinds, which an import reads only when a
 * build declares them, so they are not refused; with `skipUndeclarable` the table is imported and
 * they are warnings. What `users.xml` defines (the `default` quota and
 * profile) is the server's, and is not refused.
 *
 * Needs Docker; skips cleanly without it. One throwaway
 * `clickhouse/clickhouse-server` container at the pin, removed afterwards
 * even on failure.
 */

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { dockerAvailable, startScratchServer, type ScratchServer } from "../container";
import { clickhouseQuery } from "../http";
import { clickhouseImage } from "../../spec/pin";
import { exportResources } from "../import/live-export";
import { UndeclarableObjectsError } from "../../core/undeclarable";

const enabled = await dockerAvailable();
let server: ScratchServer | undefined;

const SEED = [
  "CREATE DATABASE analytics",
  "CREATE TABLE analytics.events (id UInt64) ENGINE = MergeTree ORDER BY id",
  "CREATE QUOTA q_reports FOR INTERVAL 1 hour MAX queries = 100",
  "CREATE SETTINGS PROFILE p_reports SETTINGS max_threads = 2",
  "CREATE NAMED COLLECTION nc_s3 AS url = 'https://example.com/bucket'",
  "CREATE WORKLOAD all",
];

beforeAll(async () => {
  if (!enabled) return;
  server = await startScratchServer(clickhouseImage(), { namePrefix: "chant-sql-undeclarable" });
  for (const stmt of SEED) await clickhouseQuery(server.endpoint, stmt);
}, 600_000);

afterAll(async () => {
  await server?.stop();
});

const run = (extra: Record<string, unknown> = {}) => exportResources({ environment: "x", config: {}, env: { CLICKHOUSE_URL: server!.endpoint.url }, ...extra });

const NAMED = ["workload all"];

describe.skipIf(!enabled)("importing a server with objects chant cannot declare", () => {
  test("fails, naming every one of them", async () => {
    const err = await run().then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(UndeclarableObjectsError);
    const objects = (err as UndeclarableObjectsError).objects.map((o) => `${o.kind} ${o.schema ? `${o.schema}.` : ""}${o.name}`);
    expect([...objects].sort()).toEqual(NAMED);
  }, 120_000);

  test("with skipUndeclarable, imports the rest and lists them as warnings", async () => {
    const ir = await run({ skipUndeclarable: true });
    expect(ir.resources.map((r) => r.properties.name)).toEqual(["analytics", "events"]);
    const left = (ir.warnings ?? []).filter((w) => w.includes("is left out (--skip-undeclarable)"));
    expect(left.map((w) => w.split(" is left out")[0]).sort()).toEqual(NAMED);
    expect(ir.metadata?.prerequisites).toEqual([{ kind: "named collection", name: "nc_s3", referencedBy: [] }]);
  }, 120_000);
});
