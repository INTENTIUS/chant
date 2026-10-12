/**
 * The `dbt` kind end to end (#3932): the sql lexicon pinned as a package,
 * its kinds file found through node_modules, and this checkout's chant CLI
 * running `workspace check` and `workspace graph`. The producer is a real
 * sql member, a chant project that declares `orders`, whose tables and
 * columns are outputs through the sql lexicon's hook (#3931).
 */

import { spawnSync } from "node:child_process";
import { readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, test } from "vitest";
import { cleanScratch, contract, declaration, REPO, repo } from "./__fixtures__/contract-repo";
import schema from "./graph.schema.json";

afterAll(cleanScratch);

const TIMEOUT = 120_000;
const LEXICON = "@intentius/chant-lexicon-sql";
const VERSION = (JSON.parse(readFileSync(join(REPO, "lexicons", "sql", "package.json"), "utf-8")) as { version: string }).version;

function chant(cwd: string, ...argv: string[]) {
  return spawnSync(process.execPath, ["--import", pathToFileURL(join(REPO, "node_modules/tsx/dist/loader.mjs")).href, join(REPO, "packages/core/src/cli/main.ts"), ...argv], {
    cwd,
    encoding: "utf-8",
    timeout: TIMEOUT,
    env: { ...process.env, NO_COLOR: "1", TSX_DISABLE_CACHE: "1" },
  });
}

const SQL_CONFIG = `import type { ChantConfig } from "@intentius/chant";\nexport default { lexicons: ["sql"], sql: { dialect: "postgres" } } satisfies ChantConfig;\n`;

const orders = (columns: string[]) =>
  [
    `import { table } from "@intentius/chant-lexicon-sql/postgres";`,
    ``,
    `export const orders = table\``,
    `  CREATE TABLE orders (`,
    ...columns.map((c, i) => `    ${c}${i < columns.length - 1 ? "," : ""}`),
    `  )\`;`,
    ``,
  ].join("\n");

function workspace(columns: string[]): string {
  const root = repo({
    "chant.workspace.json": declaration(
      [
        { name: "db", dir: "db", kind: "chant" },
        { name: "analytics", dir: "analytics", kind: "dbt", fields: { sqlMember: "db" } },
      ],
      { pins: [{ package: LEXICON, version: VERSION }] },
    ),
    "db/chant.config.ts": SQL_CONFIG,
    "db/src/orders.ts": orders(columns),
    "analytics/dbt_project.yml": "name: analytics\nversion: '1.0'\nprofile: analytics\n",
    "analytics/models/staging/sources.yml": "version: 2\n\nsources:\n  - name: shop\n    schema: public\n    tables:\n      - name: orders\n        columns:\n          - name: id\n          - name: customer_id\n",
    ".gitignore": "node_modules\n",
  });
  symlinkSync(join(REPO, "node_modules"), join(root, "node_modules"), "dir");
  return root;
}

describe("a dbt member through the pinned sql lexicon (#3932)", () => {
  test(
    "check passes while the sql member has public.orders.customer_id, and fails naming the dbt source file once it is dropped",
    () => {
      const ok = chant(workspace(["id bigint PRIMARY KEY", "customer_id bigint NOT NULL"]), "workspace", "check");
      expect(ok.status, ok.stdout + ok.stderr).toBe(0);

      const dropped = chant(workspace(["id bigint PRIMARY KEY"]), "workspace", "check");
      expect(dropped.status).toBe(1);
      const text = dropped.stdout + dropped.stderr;
      expect(text).toContain("analytics/models/staging/sources.yml:10");
      expect(text).toContain("WSP093");
      expect(text).toMatch(/link to db output public\.orders\.customer_id .*does not resolve/);
    },
    TIMEOUT,
  );

  test(
    "workspace graph lists the dbt member's links with their file and line",
    () => {
      const run = chant(workspace(["id bigint PRIMARY KEY"]), "workspace", "graph");
      const doc = JSON.parse(run.stdout) as { links: { origin: string; consumer: string; producer: string; output: string; status: string; file?: string; line?: number }[] };
      contract(schema).expectValid(doc);
      expect(doc.links.filter((l) => l.origin === "kind-reader").map((l) => `${l.consumer} -> ${l.producer}.${l.output} ${l.status} ${l.file}:${l.line}`)).toEqual([
        "analytics -> db.public.orders resolved analytics/models/staging/sources.yml:7",
        "analytics -> db.public.orders.id resolved analytics/models/staging/sources.yml:9",
        "analytics -> db.public.orders.customer_id missing analytics/models/staging/sources.yml:10",
      ]);
    },
    TIMEOUT,
  );
});
