/**
 * The live round trip (#3197): a schema on one server is imported as chant
 * declarations, built, and applied to a second, empty server; both servers'
 * catalogs then print the same `SHOW CREATE` for every object, and exporting
 * the second gives back the same declarations.
 *
 * Needs Docker; skips cleanly without it. Two throwaway
 * `clickhouse/clickhouse-server` containers at the pin, removed afterwards
 * even on failure.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { build } from "@intentius/chant/build";
import type { SerializerResult } from "@intentius/chant/serializer";
import { dockerAvailable, startScratchServer, type ScratchServer } from "../container";
import { clickhouseQuery } from "../http";
import { clickhouseImage } from "../../spec/pin";
import { exportResources } from "../import/live-export";
import { ClickHouseGenerator } from "../import/generator";
import { splitStatements } from "../import/ir";
import { readLiveSchema } from "./catalog";
import { describeResources } from "./describe-resources";
import { SCHEMA } from "../testing/roundtrip-schema";
import { sqlPlugin } from "../../plugin";
import { CLICKHOUSE_DDL_FILE, sqlSerializer } from "../../serializer";

const enabled = await dockerAvailable();
const projectDir = join(import.meta.dirname, "..", "..", "..", `.roundtrip-tmp-${process.pid}`);
let source: ScratchServer | undefined;
let target: ScratchServer | undefined;

beforeAll(async () => {
  if (!enabled) return;
  [source, target] = await Promise.all([
    startScratchServer(clickhouseImage(), { namePrefix: "chant-sql-rt-source" }),
    startScratchServer(clickhouseImage(), { namePrefix: "chant-sql-rt-target" }),
  ]);
  for (const stmt of SCHEMA) await clickhouseQuery(source.endpoint, stmt);
}, 600_000);

afterAll(async () => {
  await Promise.all([source?.stop(), target?.stop()]);
  rmSync(projectDir, { recursive: true, force: true });
});

/** Every object's SHOW CREATE, keyed by `db.name`, with the UUIDs servers mint left out. */
async function catalog(server: ScratchServer): Promise<Record<string, string>> {
  const objects = await readLiveSchema({ endpoint: server.endpoint, source: "test", defaultDatabase: "default" });
  return Object.fromEntries(
    objects.map((o) => [`${o.database ?? ""}.${o.name}`, o.statement.replace(/ UUID '[0-9a-f-]+'/g, "")]),
  );
}

describe.skipIf(!enabled)("import, build, apply, and the catalog is unchanged", () => {
  test("the round trip", async () => {
    const env = (s: ScratchServer) => ({ CLICKHOUSE_URL: s.endpoint.url });

    // Import: the source server's schema as declarations.
    const exported = await exportResources({ environment: "rt", config: {}, env: env(source!) });
    const [file] = new ClickHouseGenerator().generate(exported);
    mkdirSync(join(projectDir, "src"), { recursive: true });
    writeFileSync(join(projectDir, "chant.config.ts"), 'export default { lexicons: ["sql"] };\n');
    writeFileSync(join(projectDir, "src", file!.path), file!.content);

    // Build: the declarations fold to the statements.
    const result = await build(join(projectDir, "src"), [sqlSerializer], undefined, {
      fold: true,
      intrinsics: sqlPlugin.intrinsics!(),
      lexicons: ["sql"],
    });
    expect(result.errors).toEqual([]);
    const out = result.outputs.get("sql") as SerializerResult;

    // Apply: run the statements, in the order the build wrote them, on the empty server.
    for (const stmt of splitStatements(out.files![CLICKHOUSE_DDL_FILE]!)) await clickhouseQuery(target!.endpoint, stmt);

    // The catalog is unchanged.
    expect(await catalog(target!)).toEqual(await catalog(source!));

    // Exporting the applied server gives back the same declarations.
    const again = await exportResources({ environment: "rt", config: {}, env: env(target!) });
    expect(new ClickHouseGenerator().generate(again)[0]!.content).toBe(file!.content);

    // Every declared object is present: nothing to create.
    const entities = new Map(
      [...result.entities].map(([k, v]) => [k, { entityType: v.entityType, props: (v as unknown as { props: Record<string, unknown> }).props }]),
    );
    const observed = await describeResources({ environment: "rt", entityNames: [...entities.keys()], entities, config: {}, env: env(target!) });
    expect(Object.keys(observed).length === 0 ? [] : Object.keys((observed as { resources?: object }).resources ?? observed).sort()).toEqual([...entities.keys()].sort());
  }, 600_000);
});
