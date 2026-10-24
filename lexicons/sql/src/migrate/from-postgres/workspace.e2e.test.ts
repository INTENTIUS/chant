/**
 * Third Done-when box of #4399, through `chant workspace check`: a workspace
 * with the Postgres member `db` (the DDL of `examples/postgres-cdc-source`)
 * and the ClickHouse member `mirror`. `chant migrate` writes the mirror and its
 * links; dropping a mirrored column from the Postgres side then fails the
 * check, naming the mirror, until the mirror follows.
 *
 * The unit version of the same facts, on the example's own declarations, is
 * `example.test.ts`. This one reads a real declaration file and folds the
 * member's `.sql` file the way `chant workspace check` does, so it is e2e
 * under the 5 s unit budget (#2817). Written, not run, in the session that
 * added it.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, describe, expect, test, vi } from "vitest";
import { runDeclarationChecks } from "@intentius/chant/workspace/checks";
import { parseArgs } from "@intentius/chant/cli/parse-args";
import { runMigrate } from "@intentius/chant/cli/handlers/migrate";

const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});
afterEach(() => vi.restoreAllMocks());

function repo(files: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "chant-4399-")));
  scratch.push(root);
  execFileSync("git", ["init", "-q"], { cwd: root });
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

const schema = (email: string) => `CREATE SCHEMA shop;

CREATE TABLE shop.customers (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
${email}  country    text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE shop.orders (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  customer_id bigint NOT NULL REFERENCES shop.customers (id),
  total       numeric(12, 2) NOT NULL,
  status      text NOT NULL,
  placed_at   timestamptz NOT NULL DEFAULT now()
);
`;

const EMAIL = "  email      text NOT NULL,\n";
const config = (dialect: string) => `import type { ChantConfig } from "@intentius/chant";\nexport default { lexicons: ["sql"], sql: { dialect: "${dialect}" } } satisfies ChantConfig;\n`;

function shop(): string {
  return repo({
    "chant.workspace.json": `${JSON.stringify({ name: "shop", schema: 1, members: [{ name: "db", dir: "db", kind: "chant" }, { name: "mirror", dir: "mirror", kind: "chant" }] }, null, 2)}\n`,
    "db/chant.config.ts": config("postgres"),
    "db/schema.sql": schema(EMAIL),
    "mirror/chant.config.ts": config("clickhouse"),
  });
}

async function migrate(root: string): Promise<number> {
  vi.spyOn(console, "error").mockImplementation(() => {});
  return runMigrate({
    args: parseArgs(["migrate", join(root, "db/schema.sql"), "--from", "sql/postgres", "--to", "sql/clickhouse", "--use-composites", "--output", join(root, "mirror/src/mirrors.ts")]),
    plugins: [],
    serializers: [],
  } as never);
}

describe("chant migrate links the mirror to the Postgres member, and chant workspace check holds them", () => {
  test("the links resolve; dropping a mirrored column fails the check naming the mirror; unlinking it and migrating again passes", async () => {
    const root = shop();
    expect(await migrate(root)).toBe(0);
    const declared = JSON.parse(readFileSync(join(root, "chant.workspace.json"), "utf8")) as { members: Array<{ name: string; links?: Array<{ member: string; output: string }> }> };
    const links = declared.members.find((m) => m.name === "mirror")!.links!;
    expect(links).toHaveLength(9);
    expect(links).toContainEqual({ member: "db", output: "shop.customers.email" });

    const ok = await runDeclarationChecks(root);
    expect(ok.diagnostics.filter((d) => d.ruleId.startsWith("WSP09"))).toEqual([]);
    expect(ok.links.filter((r) => r.origin === "declared" && r.status === "resolved")).toHaveLength(9);

    // The Postgres side drops email.
    writeFileSync(join(root, "db/schema.sql"), schema(""));
    const failed = await runDeclarationChecks(root);
    expect(failed.ok).toBe(false);
    expect(failed.diagnostics.map((d) => `${d.ruleId}:${d.entity}`)).toEqual(["WSP093:mirror"]);
    expect(failed.diagnostics[0]!.message).toContain("db has no output shop.customers.email");

    // The mirror follows: the link goes with the column, and migrating again adds nothing it should not.
    const edited = { ...declared, members: declared.members.map((m) => (m.name === "mirror" ? { ...m, links: m.links!.filter((l) => l.output !== "shop.customers.email") } : m)) };
    writeFileSync(join(root, "chant.workspace.json"), `${JSON.stringify(edited, null, 2)}\n`);
    expect(await migrate(root)).toBe(0);
    const after = await runDeclarationChecks(root);
    expect(after.diagnostics.filter((d) => d.ruleId.startsWith("WSP09"))).toEqual([]);
  });

  test("a renamed column with a previously hint tells the mirror where it went", async () => {
    const root = shop();
    await migrate(root);
    writeFileSync(join(root, "db/schema.sql"), schema("  email_hash text NOT NULL, -- previously: email\n"));
    const report = await runDeclarationChecks(root);
    expect(report.diagnostics[0]!.message).toContain("it was renamed to shop.customers.email_hash, so link to that instead");
  });
});
