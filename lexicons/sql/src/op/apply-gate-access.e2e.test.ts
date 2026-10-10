/**
 * An approval does not cover a privilege granted by hand after it (#3706),
 * end to end on Postgres with a profile that manages access.
 *
 * A project in a temporary directory declares a schema, a table and a grant
 * of SELECT on it to a reader role, and a gated `ApplyOp`. The first approved
 * run creates them. The next run stops at the gate; the test approves its
 * plan, grants INSERT on the table to another role by hand, and runs again.
 * The gate refuses with "is approved, but not for this plan", the hand grant
 * is still there, and the plan the run printed lists the REVOKE an apply
 * would make. Approving that plan applies it.
 *
 * Before #3706 the plan digest was taken over a diff that left privileges
 * out (a grant was unobserved there), so the third run revoked the hand
 * grant under the earlier approval.
 *
 * Everything is written to the schema `chant_e2e_3706` and the roles
 * `chant_e2e_3706_reader` and `chant_e2e_3706_writer`, all dropped afterwards.
 *
 * The server: `CHANT_SQL_GATE_POSTGRES_URL` (a `postgres://user@host:port/db`
 * URL, with `CHANT_SQL_GATE_POSTGRES_PASSWORD`) names a running one, such as
 * the one `chant emulator up --lexicon sql` starts. Without it, a throwaway
 * server at the pin, skipped cleanly when Docker is not available.
 */

import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { dockerAvailable, startTestPostgres, type TestPostgres } from "../postgres/testing/server";
import { connectPostgres, type PostgresClient, type PostgresEndpoint } from "../postgres/live/client";

const exec = promisify(execFile);

const REPO = join(import.meta.dirname, "../../../..");
const BIN = join(REPO, "node_modules/.bin");
const S = "chant_e2e_3706";
const READER = "chant_e2e_3706_reader";
const WRITER = "chant_e2e_3706_writer";
const OP = "schema-apply";

const given = process.env.CHANT_SQL_GATE_POSTGRES_URL;
const enabled = given ? true : await dockerAvailable();

interface Run {
  code: number;
  output: string;
}

const strip = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, "");

const SCHEMA = `import { schema, table, grant } from "@intentius/chant-lexicon-sql/postgres";

export const app = schema\`CREATE SCHEMA ${S}\`;

export const orders = table\`
  CREATE TABLE \${app}.orders (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    total numeric NOT NULL
  )\`;

export const readOrders = grant\`GRANT SELECT ON TABLE \${orders} TO ${READER}\`;
`;

const OPS = `import { ApplyOp } from "@intentius/chant/op";
const { op } = ApplyOp({ name: "${OP}", env: "admin", target: "postgres", gate: { gate: "approve-schema" } });
export default op;
`;

const config = (url: string) => `import type { ChantConfig } from "@intentius/chant";
import "@intentius/chant-lexicon-sql";

export default {
  lexicons: ["sql"],
  ownership: { stack: "e2e-3706", env: "admin" },
  sql: ${JSON.stringify({ dialect: "postgres", profiles: { admin: { url, password: { env: "ADMIN_PASSWORD" }, schemas: [S], access: true } } }, null, 2)},
} satisfies ChantConfig;
`;

/** The `--plan <digest>` the stopped run printed in its approve command. */
function approvedPlan(run: Run): string {
  const m = /chant approve \S+ \S+ .*?--plan (jcs1-sha256:[0-9a-f]{64})/.exec(run.output);
  if (!m) throw new Error(`the run printed no approve command with a plan:\n${run.output}`);
  return m[1];
}

function gateOf(run: Run): string {
  const m = /chant approve \S+ (\S+)/.exec(run.output);
  if (!m) throw new Error(`the run printed no approve command:\n${run.output}`);
  return m[1];
}

describe.skipIf(!enabled)("a gated ApplyOp over Postgres refuses after a privilege granted by hand (#3706)", () => {
  let server: TestPostgres | undefined;
  let endpoint: PostgresEndpoint;
  let admin: PostgresClient;
  let dir: string | undefined;
  const cleanup = async () => {
    await admin.query(`DROP SCHEMA IF EXISTS ${S} CASCADE`);
    for (const r of [READER, WRITER]) await admin.query(`DROP ROLE IF EXISTS ${r}`);
  };

  const chant = async (...args: string[]): Promise<Run> => {
    try {
      const r = await exec(join(BIN, "chant"), args, {
        cwd: dir,
        env: { ...process.env, ADMIN_PASSWORD: endpoint.password ?? "", PATH: `${BIN}:${process.env.PATH ?? ""}` },
        maxBuffer: 16 * 1024 * 1024,
      });
      return { code: 0, output: strip(`${r.stdout}${r.stderr}`) };
    } catch (err) {
      const e = err as { code?: number; stdout?: string; stderr?: string };
      return { code: typeof e.code === "number" ? e.code : 1, output: strip(`${e.stdout ?? ""}${e.stderr ?? ""}`) };
    }
  };

  /** Run the Op, approve the plan it stopped at, run again: the apply converges. */
  const approveAndRun = async (): Promise<Run> => {
    const stopped = await chant("run", OP);
    const approve = await chant("approve", OP, gateOf(stopped), "--plan", approvedPlan(stopped));
    expect(approve.code, approve.output).toBe(0);
    const run = await chant("run", OP);
    expect(run.output).toMatch(/Op "schema-apply" completed/);
    return run;
  };

  const writerPrivileges = async () =>
    (
      await admin.query<{ p: string }>(
        `SELECT privilege_type AS p FROM information_schema.role_table_grants WHERE table_schema = '${S}' AND table_name = 'orders' AND grantee = '${WRITER}'`,
      )
    ).map((r) => r.p);

  beforeAll(async () => {
    if (given) endpoint = { url: given, password: process.env.CHANT_SQL_GATE_POSTGRES_PASSWORD };
    else {
      server = await startTestPostgres();
      endpoint = server.endpoint();
    }
    admin = await connectPostgres(endpoint);
    await cleanup();
    // The roles are the environment's: provisioned outside the declarations, only named in them.
    for (const r of [READER, WRITER]) await admin.query(`CREATE ROLE ${r} NOLOGIN`);
    dir = mkdtempSync(join(tmpdir(), "chant-sql-gate-access-"));
    symlinkSync(join(REPO, "node_modules"), join(dir, "node_modules"), "dir");
    const files: Record<string, string> = {
      "package.json": JSON.stringify({ name: "sql-gate-access-e2e", private: true, type: "module", scripts: { build: "chant build src --lexicon sql -o dist/schema.json" } }),
      ".gitignore": "node_modules\ndist\n.chant\n",
      "chant.config.ts": config(endpoint.url),
      "ops/apply.op.ts": OPS,
      "src/schema.ts": SCHEMA,
    };
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(join(dir, path, ".."), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
    const git = (...args: string[]) => exec("git", ["-c", "user.email=e2e@chant.invalid", "-c", "user.name=e2e", ...args], { cwd: dir });
    await git("init", "-q");
    await git("add", "-A");
    await git("commit", "-qm", "the schema");
  }, 600_000);

  afterAll(async () => {
    if (admin) {
      await cleanup().catch(() => undefined);
      await admin.end();
    }
    await server?.stop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test("approve, grant by hand, rerun: the gate refuses and the hand grant stays", async () => {
    await approveAndRun();
    const readers = await admin.query<{ p: string }>(
      `SELECT privilege_type AS p FROM information_schema.role_table_grants WHERE table_schema = '${S}' AND table_name = 'orders' AND grantee = '${READER}'`,
    );
    expect(readers.map((r) => r.p)).toEqual(["SELECT"]);

    // Nothing to change: the run stops at the gate, and its plan is approved.
    const first = await chant("run", OP);
    expect(first.output).not.toContain("PENDING (");
    const gate = gateOf(first);
    const digest = approvedPlan(first);
    const approve = await chant("approve", OP, gate, "--plan", digest);
    expect(approve.code, approve.output).toBe(0);

    await admin.query(`GRANT INSERT ON ${S}.orders TO ${WRITER}`);

    const second = await chant("run", OP);
    expect(second.output).toContain(`Gate "${gate}" is approved, but not for this plan.`);
    expect(second.output).toContain(`approved: ${digest}`);
    expect(second.output).toMatch(/PENDING \(changes an apply would make that no declared property shows\):\s+~ relation chant_e2e_3706\.orders TO chant_e2e_3706_writer: REVOKE INSERT ON TABLE chant_e2e_3706\.orders FROM chant_e2e_3706_writer/);
    expect(second.output).not.toMatch(/Op "schema-apply" completed/);
    expect(await writerPrivileges()).toEqual(["INSERT"]);

    // Approving the plan the second run produced applies the revoke.
    const fresh = approvedPlan(second);
    expect(fresh).not.toBe(digest);
    const reapprove = await chant("approve", OP, gate, "--plan", fresh);
    expect(reapprove.code, reapprove.output).toBe(0);
    const third = await chant("run", OP);
    expect(third.output).toMatch(/Op "schema-apply" completed/);
    expect(await writerPrivileges()).toEqual([]);
  }, 600_000);
});
