/**
 * `drizzle-kit generate` finds nothing to migrate (#4401). The declaration of
 * `examples/postgres-getting-started` is applied to a throwaway Postgres;
 * `drizzle-kit pull` writes what the server holds as drizzle-kit's baseline
 * snapshot (`generate` compares a schema with the last snapshot in its `out`
 * directory, never with a server); then `drizzle-kit generate` runs against
 * the schema `chant sql drizzle` wrote and must report no changes and write no
 * new migration.
 *
 * Needs Docker and network access (npm installs drizzle-orm and drizzle-kit in
 * a scratch directory). Skipped without Docker.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { build } from "@intentius/chant/build";
import { resolveProjectBuildOptions } from "@intentius/chant/cli/build-options";
import { DRIZZLE_ORM_CHECKED, renderDrizzle } from "./drizzle";
import { sqlPlugin } from "./plugin";
import { dockerAvailable, startTestPostgres, type TestPostgres } from "./postgres/testing/server";
import { serializedObjects } from "./sql-types";
import { sqlSerializer } from "./serializer";

const here = dirname(fileURLToPath(import.meta.url));
const DRIZZLE_KIT = "0.31.11";
const docker = await dockerAvailable();

describe.skipIf(!docker)("drizzle-kit generate against a database applied from the declaration", () => {
  let server: TestPostgres;
  const work = mkdtempSync(join(tmpdir(), "chant-4401-kit-"));

  beforeAll(async () => {
    server = await startTestPostgres();
  }, 180_000);

  afterAll(async () => {
    await server?.stop();
    rmSync(work, { recursive: true, force: true });
  });

  const kit = (...args: string[]): string => execFileSync("npx", ["--no-install", "drizzle-kit", ...args], { cwd: work, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

  test("no migration", async () => {
    const dir = join(here, "..", "examples", "postgres-getting-started");
    const options = resolveProjectBuildOptions({ config: {}, configDir: dir, plugins: [sqlPlugin], modes: { fold: true, sandbox: false } });
    const result = await build(join(dir, "src"), [sqlSerializer], undefined, options);
    expect(result.errors.map(String)).toEqual([]);
    const config = { sql: { dialect: "postgres" } };

    // The declaration, applied in its own order.
    const doc = serializedObjects(result.entities, config) as { objects: Array<{ export: string; ddl: string }>; applyOrder?: string[] };
    const byExport = new Map(doc.objects.map((o) => [o.export, o]));
    const client = await server.connect();
    try {
      for (const name of doc.applyOrder ?? doc.objects.map((o) => o.export)) await client.query(byExport.get(name)!.ddl);
    } finally {
      await client.end();
    }

    writeFileSync(join(work, "package.json"), JSON.stringify({ name: "kit-scratch", private: true, type: "module" }));
    execFileSync("npm", ["install", "--silent", `drizzle-orm@${DRIZZLE_ORM_CHECKED}`, `drizzle-kit@${DRIZZLE_KIT}`, "pg"], { cwd: work, stdio: "inherit" });
    writeFileSync(join(work, "schema.ts"), renderDrizzle(result.entities, { config }).text);
    const { url, password } = server.endpoint();
    writeFileSync(
      join(work, "drizzle.config.ts"),
      `import { defineConfig } from "drizzle-kit";
export default defineConfig({
  dialect: "postgresql",
  schema: "./schema.ts",
  out: "./out",
  schemaFilter: ["app"],
  dbCredentials: { url: ${JSON.stringify(url.replace("postgres@", `postgres:${password}@`))}, ssl: false },
});
`,
    );

    kit("pull");
    const before = readdirSync(join(work, "out")).filter((f) => f.endsWith(".sql"));
    expect(before).toHaveLength(1);

    const out = kit("generate");
    expect(out).toMatch(/No schema changes, nothing to migrate/);
    expect(readdirSync(join(work, "out")).filter((f) => f.endsWith(".sql"))).toEqual(before);
  }, 600_000);
});
