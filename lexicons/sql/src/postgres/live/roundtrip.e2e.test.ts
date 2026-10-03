/**
 * The live round trip (#3279): a schema on one Postgres database is imported
 * as chant declarations, built, and applied to a second, empty database;
 * both catalogs then print the same statements for every object, exporting
 * the second gives back the same declarations, every declared object is
 * present, and the deep read of the applied database reports no drift from
 * the declarations.
 *
 * Needs Docker; skips cleanly without it. One throwaway `postgres` container
 * at the pin (18.6, by tag and digest), removed afterwards even on failure.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { build } from "@intentius/chant/build";
import type { SerializerResult } from "@intentius/chant/serializer";
import { dockerAvailable, startTestPostgres, type TestPostgres } from "../testing/server";
import { ROUNDTRIP_SCHEMA } from "../testing/roundtrip-schema";
import { exportResources } from "../import/live-export";
import { PostgresGenerator } from "../import/generator";
import { readLiveSchema } from "./catalog";
import { describeResources } from "./describe-resources";
import { observeResourcesDeep } from "../plan/deep";
import { sqlPlugin } from "../../plugin";
import { POSTGRES_DDL_FILE, sqlSerializer } from "../../serializer";

const enabled = await dockerAvailable();
const projectDir = join(import.meta.dirname, "..", "..", "..", `.pg-roundtrip-tmp-${process.pid}`);
let server: TestPostgres | undefined;

beforeAll(async () => {
  if (!enabled) return;
  server = await startTestPostgres();
  const admin = await server.connect();
  await admin.query("CREATE DATABASE source");
  await admin.query("CREATE DATABASE target");
  await admin.end();
  const source = await server.connect("source");
  await source.query(ROUNDTRIP_SCHEMA);
  await source.end();
}, 600_000);

afterAll(async () => {
  await server?.stop();
  rmSync(projectDir, { recursive: true, force: true });
});

const profile = (db: string) => ({
  config: { sql: { profiles: { rt: { url: server!.endpoint(db).url, password: { env: "PG_RT_PASSWORD" } } } } },
  env: { PG_RT_PASSWORD: server!.endpoint(db).password },
});

/** The props a deep diff compares: the declaration's, less what the hooks prune. */
const PRUNED = new Set(["ddl", "source", "lineage", "reads", "concurrently", "orReplace", "ifNotExists"]);
const compared = (props: Record<string, unknown>) =>
  JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(props).filter(([k]) => !PRUNED.has(k))), (_k, v: unknown) =>
    v !== null && typeof v === "object" && "sqlName" in (v as object) && "entityType" in (v as object) ? `ref:${(v as { sqlName: string }).sqlName}` : v,
  )) as Record<string, unknown>;

async function catalog(db: string): Promise<Record<string, string>> {
  const client = await server!.connect(db);
  try {
    return Object.fromEntries((await readLiveSchema(client)).filter((o) => !o.foreign).map((o) => [`${o.type} ${o.schema ?? ""}.${o.name}`, o.statement]));
  } finally {
    await client.end();
  }
}

describe.skipIf(!enabled)("import, build, apply, and the catalog is unchanged", () => {
  test("the round trip", async () => {
    // Import: the source database's schema as declarations. The ORM's table is left out, with a warning.
    const exported = await exportResources({ environment: "rt", ...profile("source") });
    expect(exported.warnings?.some((w) => /_prisma_migrations is kept by Prisma Migrate/.test(w))).toBe(true);
    const [file] = new PostgresGenerator().generate(exported);
    mkdirSync(join(projectDir, "src"), { recursive: true });
    writeFileSync(join(projectDir, "chant.config.ts"), 'export default { lexicons: ["sql"] };\n');
    writeFileSync(join(projectDir, "src", file!.path), file!.content);

    // Build: the declarations fold to the statements.
    const result = await build(join(projectDir, "src"), [sqlSerializer], undefined, { fold: true, intrinsics: sqlPlugin.intrinsics!(), lexicons: ["sql"] });
    expect(result.errors).toEqual([]);
    const out = result.outputs.get("sql") as SerializerResult;

    // Apply: run the statements, in the order the build wrote them, on the empty database.
    const target = await server!.connect("target");
    await target.query(out.files![POSTGRES_DDL_FILE]!);
    await target.end();

    // The catalog is unchanged.
    expect(await catalog("target")).toEqual(await catalog("source"));

    // Exporting the applied database gives back the same declarations.
    const again = await exportResources({ environment: "rt", ...profile("target") });
    expect(new PostgresGenerator().generate(again)[0]!.content).toBe(file!.content);

    // Every declared object is present: nothing to create.
    const entities = new Map(
      [...result.entities].map(([k, v]) => [k, { entityType: v.entityType, props: (v as unknown as { props: Record<string, unknown> }).props }]),
    );
    const observed = await describeResources({ environment: "rt", entityNames: [...entities.keys()], entities, ...profile("target") });
    expect(Object.keys((observed as { resources: object }).resources).sort()).toEqual([...entities.keys()].sort());

    // The deep read reports no property drift from the declarations.
    const deep = await observeResourcesDeep({ environment: "rt", entityNames: [...entities.keys()], entities, ...profile("target") });
    expect(deep.unobserved ?? {}).toEqual({});
    for (const [name, e] of entities) {
      expect(compared(deep.resources[name]!.properties), name).toEqual(JSON.parse(JSON.stringify(compared(e.props))));
    }
  }, 600_000);
});
