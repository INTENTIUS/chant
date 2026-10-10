/**
 * An approval does not cover a ClickHouse privilege granted by hand after it
 * (#3733), end to end with a profile that manages access. The Postgres
 * counterpart is `./apply-gate-access.e2e.test.ts`.
 *
 * A project in a temporary directory declares a database, a table, a reader
 * role and a grant of SELECT on the table to it, and a gated `ApplyOp`. The
 * first approved run creates them. The next run stops at the gate; the test
 * approves its plan, grants INSERT on the table to the role by hand, and runs
 * again. The gate refuses with "is approved, but not for this plan", the hand
 * grant is still there, and the plan the run printed lists the REVOKE an
 * apply would make. Approving that plan applies it.
 *
 * Before #3733 the plan digest was taken over a diff that left grants out (a
 * grant was unobserved there), so the third run revoked the hand grant under
 * the earlier approval.
 *
 * Everything is written to the database `chant_e2e_3733` and the role
 * `chant_e2e_3733_reader`, both dropped afterwards.
 *
 * The server: `CHANT_SQL_GATE_CLICKHOUSE_URL` names a running one, such as
 * the one `chant emulator up --lexicon sql` starts. Without it, a throwaway
 * server at the pin, skipped cleanly when Docker is not available.
 */

import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { dockerAvailable, startScratchServer, type ScratchServer } from "../clickhouse/container";
import { clickhouseQuery, type ClickHouseEndpoint } from "../clickhouse/http";
import { clickhouseImage } from "../spec/pin";

const exec = promisify(execFile);

const REPO = join(import.meta.dirname, "../../../..");
const BIN = join(REPO, "node_modules/.bin");
const DB = "chant_e2e_3733";
const READER = "chant_e2e_3733_reader";
const OP = "schema-apply";

const given = process.env.CHANT_SQL_GATE_CLICKHOUSE_URL;
const enabled = given ? true : await dockerAvailable();

interface Run {
  code: number;
  output: string;
}

const strip = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, "");

const SCHEMA = `import { database, table, role, grant } from "@intentius/chant-lexicon-sql/clickhouse";

export const db = database\`CREATE DATABASE ${DB} ENGINE = Atomic\`;

export const events = table\`
  CREATE TABLE \${db}.events (
    id UInt64,
    kind String
  )
  ENGINE = MergeTree
  ORDER BY id\`;

export const reader = role\`CREATE ROLE ${READER}\`;

export const readEvents = grant\`GRANT SELECT ON \${events} TO \${reader}\`;
`;

const OPS = `import { ApplyOp } from "@intentius/chant/op";
const { op } = ApplyOp({ name: "${OP}", env: "admin", target: "clickhouse", gate: { gate: "approve-schema" } });
export default op;
`;

const config = (url: string) => `import type { ChantConfig } from "@intentius/chant";
import "@intentius/chant-lexicon-sql";

export default {
  lexicons: ["sql"],
  ownership: { stack: "e2e-3733", env: "admin" },
  sql: ${JSON.stringify({ dialect: "clickhouse", profiles: { admin: { url, databases: [DB], access: true } } }, null, 2)},
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

describe.skipIf(!enabled)("a gated ApplyOp over ClickHouse refuses after a privilege granted by hand (#3733)", () => {
  let server: ScratchServer | undefined;
  let admin: ClickHouseEndpoint;
  let dir: string | undefined;
  const q = <T = Record<string, unknown>>(sql: string) => clickhouseQuery<T>(admin, sql);
  const cleanup = async () => {
    await q(`DROP ROLE IF EXISTS ${READER}`);
    await q(`DROP DATABASE IF EXISTS ${DB} SYNC`);
  };

  const chant = async (...args: string[]): Promise<Run> => {
    try {
      const r = await exec(join(BIN, "chant"), args, {
        cwd: dir,
        env: { ...process.env, PATH: `${BIN}:${process.env.PATH ?? ""}` },
        maxBuffer: 16 * 1024 * 1024,
      });
      return { code: 0, output: strip(`${r.stdout}${r.stderr}`) };
    } catch (err) {
      const e = err as { code?: number; stdout?: string; stderr?: string };
      return { code: typeof e.code === "number" ? e.code : 1, output: strip(`${e.stdout ?? ""}${e.stderr ?? ""}`) };
    }
  };

  /** What `SHOW GRANTS FOR` the reader prints, one grant per line. */
  const readerGrants = async () => (await q<Record<string, string>>(`SHOW GRANTS FOR ${READER}`)).map((r) => Object.values(r)[0]!);

  beforeAll(async () => {
    if (given) admin = { url: given };
    else {
      server = await startScratchServer(clickhouseImage(), { namePrefix: "chant-sql-gate-access" });
      admin = server.endpoint;
    }
    await cleanup();
    dir = mkdtempSync(join(tmpdir(), "chant-sql-gate-access-ch-"));
    symlinkSync(join(REPO, "node_modules"), join(dir, "node_modules"), "dir");
    const files: Record<string, string> = {
      "package.json": JSON.stringify({ name: "sql-gate-access-ch-e2e", private: true, type: "module", scripts: { build: "chant build src --lexicon sql -o dist/schema.json" } }),
      ".gitignore": "node_modules\ndist\n.chant\n",
      "chant.config.ts": config(admin.url),
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
    if (admin) await cleanup().catch(() => undefined);
    await server?.stop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test("approve, grant by hand, rerun: the gate refuses and the hand grant stays", async () => {
    // The first run creates everything once its plan is approved.
    const created = await chant("run", OP);
    const approveCreate = await chant("approve", OP, gateOf(created), "--plan", approvedPlan(created));
    expect(approveCreate.code, approveCreate.output).toBe(0);
    const applied = await chant("run", OP);
    expect(applied.output).toMatch(/Op "schema-apply" completed/);
    expect(await readerGrants()).toEqual([`GRANT SELECT ON ${DB}.events TO ${READER}`]);

    // Nothing to change: the run stops at the gate, and its plan is approved.
    const first = await chant("run", OP);
    expect(first.output).not.toContain("PENDING (");
    const gate = gateOf(first);
    const digest = approvedPlan(first);
    const approve = await chant("approve", OP, gate, "--plan", digest);
    expect(approve.code, approve.output).toBe(0);

    await q(`GRANT INSERT ON ${DB}.events TO ${READER}`);

    const second = await chant("run", OP);
    expect(second.output).toContain(`Gate "${gate}" is approved, but not for this plan.`);
    expect(second.output).toContain(`approved: ${digest}`);
    expect(second.output).toMatch(
      /PENDING \(changes an apply would make that no declared property shows\):\s+~ grants chant_e2e_3733_reader: REVOKE INSERT ON `chant_e2e_3733`\.`events` FROM `chant_e2e_3733_reader` \[from: readEvents\]/,
    );
    expect(second.output).not.toMatch(/Op "schema-apply" completed/);
    expect((await readerGrants()).join("\n")).toMatch(/GRANT INSERT, SELECT ON chant_e2e_3733\.events TO chant_e2e_3733_reader|GRANT SELECT, INSERT ON chant_e2e_3733\.events/);

    // Approving the plan the second run produced applies the revoke.
    const fresh = approvedPlan(second);
    expect(fresh).not.toBe(digest);
    const reapprove = await chant("approve", OP, gate, "--plan", fresh);
    expect(reapprove.code, reapprove.output).toBe(0);
    const third = await chant("run", OP);
    expect(third.output).toMatch(/Op "schema-apply" completed/);
    expect(await readerGrants()).toEqual([`GRANT SELECT ON ${DB}.events TO ${READER}`]);
  }, 600_000);
});
