/**
 * A sql member's tables and columns as workspace outputs (#3931), end to end:
 * a workspace with a sql member and an app member that links to one column.
 * `chant workspace check` reads the sql member's declarations by folding its
 * source, never running it, so dropping or renaming the column fails the
 * check and names the consumer. Once for Postgres, once for ClickHouse.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, describe, expect, test, vi } from "vitest";
import { runDeclarationChecks } from "@intentius/chant/workspace/checks";
import { runWorkspaceCheck } from "@intentius/chant/workspace/lineage-check";
import { parseArgs } from "@intentius/chant/cli/main";

const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});
afterEach(() => {
  vi.restoreAllMocks();
});

function repo(files: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "chant-3931-")));
  scratch.push(root);
  execFileSync("git", ["init", "-q"], { cwd: root });
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

const workspace = (output: string) =>
  JSON.stringify(
    {
      name: "shop",
      schema: 1,
      members: [
        { name: "db", dir: "db", kind: "chant" },
        { name: "app", dir: "app", kind: "other", because: "the service that reads the database", links: [{ member: "db", output }] },
      ],
    },
    null,
    2,
  );

const config = (dialect: string) => `import type { ChantConfig } from "@intentius/chant";\nexport default { lexicons: ["sql"], sql: { dialect: "${dialect}" } } satisfies ChantConfig;\n`;

const postgresOrders = (columns: string) =>
  [
    `import { table } from "@intentius/chant-lexicon-sql/postgres";`,
    ``,
    `export const orders = table\``,
    `  CREATE TABLE orders (`,
    `    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,`,
    columns,
    `    amount numeric(12, 2) NOT NULL`,
    `  )\`;`,
    ``,
  ].join("\n");

const clickhouseEvents = (columns: string) =>
  [
    `import { database, table } from "@intentius/chant-lexicon-sql/clickhouse";`,
    ``,
    `export const analytics = database\`CREATE DATABASE analytics\`;`,
    `export const events = table\``,
    `  CREATE TABLE \${analytics}.events (`,
    `    ts DateTime,`,
    columns,
    `    kind LowCardinality(String)`,
    `  )`,
    `  ENGINE = MergeTree`,
    `  ORDER BY ts\`;`,
    ``,
  ].join("\n");

function shop(dialect: "postgres" | "clickhouse", output: string, source: string): string {
  return repo({
    "chant.workspace.json": workspace(output),
    "db/chant.config.ts": config(dialect),
    [`db/src/${dialect === "postgres" ? "orders" : "events"}.ts`]: source,
    "app/README.md": "reads the database\n",
  });
}

/** Every member of kind other gets WSP009; the app member here is one on purpose. */
async function check(root: string) {
  const report = await runDeclarationChecks(root);
  return { ...report, diagnostics: report.diagnostics.filter((d) => d.ruleId !== "WSP009") };
}

async function checkExit(root: string): Promise<{ code: number; out: string }> {
  vi.spyOn(process, "cwd").mockReturnValue(root);
  let out = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    out += String(chunk);
    return true;
  });
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    out += `${args.join(" ")}\n`;
  });
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    out += `${args.join(" ")}\n`;
  });
  const code = await runWorkspaceCheck({ args: parseArgs(["workspace", "check"]), plugins: [] } as never);
  return { code, out };
}

describe("a sql member's columns are outputs a link can name (#3931)", () => {
  test("Postgres: a link to public.orders.customer_id resolves, and fails check naming the consumer once the column is dropped", async () => {
    const kept = shop("postgres", "public.orders.customer_id", postgresOrders(`    customer_id bigint NOT NULL,`));
    const ok = await check(kept);
    expect(ok.diagnostics).toEqual([]);
    expect(ok.links.filter((r) => r.origin === "declared")).toMatchObject([{ consumer: "app", producer: "db", output: "public.orders.customer_id", status: "resolved" }]);
    expect((await checkExit(kept)).code).toBe(0);

    const dropped = shop("postgres", "public.orders.customer_id", postgresOrders(``));
    const report = await check(dropped);
    expect(report.ok).toBe(false);
    expect(report.diagnostics.map((d) => `${d.ruleId}:${d.entity}`)).toEqual(["WSP093:app"]);
    expect(report.diagnostics[0]!.message).toBe(
      "app's link to db output public.orders.customer_id does not resolve: db has no output public.orders.customer_id; its outputs: public.orders, public.orders.amount, public.orders.id",
    );
    const cli = await checkExit(dropped);
    expect(cli.code).not.toBe(0);
    expect(cli.out).toContain("app's link to db output public.orders.customer_id does not resolve");
  });

  test("Postgres: a renamed column points the old name at the new one", async () => {
    const root = shop("postgres", "public.orders.customer_id", postgresOrders(`    buyer_id bigint NOT NULL, -- previously: customer_id`));
    const [d] = (await check(root)).diagnostics;
    expect(d?.ruleId).toBe("WSP093");
    expect(d?.message).toContain("db has no output public.orders.customer_id; it was renamed to public.orders.buyer_id, so link to that instead");
  });

  test("Postgres: a quoted mixed-case table is a different output, and the hint names it", async () => {
    const root = shop(
      "postgres",
      "public.orders.customer_id",
      [`import { table } from "@intentius/chant-lexicon-sql/postgres";`, `export const orders = table\`CREATE TABLE "Orders" (customer_id bigint)\`;`, ``].join("\n"),
    );
    const [d] = (await check(root)).diagnostics;
    expect(d?.message).toContain("db has no output public.orders.customer_id; did you mean public.Orders.customer_id? Links match exactly");
  });

  test("Postgres: a file of tables that does not fold leaves the link unresolved, not missing, and is never run", async () => {
    const root = shop(
      "postgres",
      "public.orders.customer_id",
      [
        `import { table } from "@intentius/chant-lexicon-sql/postgres";`,
        `const name = process.env.ORDERS_TABLE ?? "orders";`,
        `throw new Error("member code ran");`,
        `export const orders = table\`CREATE TABLE \${name} (customer_id bigint)\`;`,
        ``,
      ].join("\n"),
    );
    const report = await check(root);
    expect(report.ok).toBe(true);
    expect(report.diagnostics.map((d) => d.ruleId)).toEqual(["WSP094"]);
    expect(report.diagnostics[0]!.message).toContain("db/src/orders.ts imports the sql lexicon and does not fold");
  });

  test("ClickHouse: a link to analytics.events.user_id resolves, and fails check naming the consumer once the column is dropped", async () => {
    const kept = shop("clickhouse", "analytics.events.user_id", clickhouseEvents(`    user_id UUID,`));
    const ok = await check(kept);
    expect(ok.diagnostics).toEqual([]);
    expect(ok.links.filter((r) => r.origin === "declared")).toMatchObject([{ consumer: "app", producer: "db", output: "analytics.events.user_id", status: "resolved" }]);

    const dropped = shop("clickhouse", "analytics.events.user_id", clickhouseEvents(``));
    const report = await check(dropped);
    expect(report.diagnostics.map((d) => `${d.ruleId}:${d.entity}`)).toEqual(["WSP093:app"]);
    expect(report.diagnostics[0]!.message).toBe(
      "app's link to db output analytics.events.user_id does not resolve: db has no output analytics.events.user_id; its outputs: analytics.events, analytics.events.kind, analytics.events.ts",
    );
    const cli = await checkExit(dropped);
    expect(cli.code).not.toBe(0);
    expect(cli.out).toContain("app's link to db output analytics.events.user_id does not resolve");
  });
});
