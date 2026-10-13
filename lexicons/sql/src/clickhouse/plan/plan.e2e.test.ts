/**
 * Planning against a live server (#3197): the getting-started example applied
 * to a pinned server plans with no changes, its deep read reports no drift,
 * and a change made on the server is reported and classified.
 *
 * Needs Docker; skips cleanly without it.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { build } from "@intentius/chant/build";
import type { SerializerResult } from "@intentius/chant/serializer";
import { dockerAvailable, startScratchServer, type ScratchServer } from "../container";
import { clickhouseQuery } from "../http";
import { clickhouseImage } from "../../spec/pin";
import { splitStatements } from "../import/ir";
import { planAgainstServer } from "./commands";
import { observeResourcesDeep, sqlDeepNormalizationHooks } from "./deep";
import { sqlPlugin } from "../../plugin";
import { CLICKHOUSE_DDL_FILE, sqlSerializer } from "../../serializer";

const enabled = await dockerAvailable();
let server: ScratchServer | undefined;
const dir = mkdtempSync(join(tmpdir(), "chant-sql-plan-"));
const buildFile = join(dir, "schema.json");
let entities = new Map<string, { entityType: string; props: Record<string, unknown> }>();

beforeAll(async () => {
  if (!enabled) return;
  server = await startScratchServer(clickhouseImage(), { namePrefix: "chant-sql-plan" });
  const src = join(import.meta.dirname, "..", "..", "..", "examples", "getting-started", "src");
  const result = await build(src, [sqlSerializer], undefined, { fold: true, intrinsics: sqlPlugin.intrinsics!(), lexicons: ["sql"] });
  const out = result.outputs.get("sql") as SerializerResult;
  writeFileSync(buildFile, out.primary);
  for (const stmt of splitStatements(out.files![CLICKHOUSE_DDL_FILE]!)) await clickhouseQuery(server.endpoint, stmt);
  entities = new Map(
    [...result.entities].map(([k, v]) => [k, { entityType: v.entityType, props: (v as unknown as { props: Record<string, unknown> }).props }]),
  );
}, 600_000);

afterAll(async () => {
  await server?.stop();
  rmSync(dir, { recursive: true, force: true });
});

const env = () => ({ config: {}, env: { CLICKHOUSE_URL: server!.endpoint.url } });

/** The props a deep diff compares: the declaration's, less what the hooks prune. */
function compared(props: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(props).filter(([k]) => !sqlDeepNormalizationHooks.prune!({ pattern: k } as never)));
}

describe.skipIf(!enabled)("planning the getting-started example against a server", () => {
  test("applied as declared, it plans with no changes and reads back with no drift", async () => {
    const diff = await planAgainstServer("e2e", buildFile, env());
    expect(diff.changes).toEqual([]);

    const deep = await observeResourcesDeep({ environment: "e2e", entityNames: [...entities.keys()], entities, ...env() });
    expect(deep.unobserved ?? {}).toEqual({});
    for (const [name, e] of entities) {
      expect(compared(deep.resources[name]!.properties), name).toEqual(JSON.parse(JSON.stringify(compared(e.props))));
    }
  }, 120_000);

  test("a change made on the server is drift, classified", async () => {
    await clickhouseQuery(server!.endpoint, "ALTER TABLE analytics.events MODIFY TTL ts + INTERVAL 90 DAY");
    await clickhouseQuery(server!.endpoint, "ALTER TABLE analytics.users ADD COLUMN extra String");
    const diff = await planAgainstServer("e2e", buildFile, env());
    expect(diff.changes.map((c) => [c.object, c.field, c.rule])).toEqual([
      ["events (analytics.events)", "ttl", "SQLCH205"],
      ["users (analytics.users)", "columns.extra", "SQLCH202"],
    ]);
    expect(diff.rebuilds).toEqual([]);
  }, 120_000);
});
