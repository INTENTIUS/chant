import { describe, expect, test } from "vitest";
import { withTestDir } from "@intentius/chant-test-utils";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { composeChangeSet } from "../change-set";
import { changeSetFile } from "./change-set-store";
import { resolveLedgerCommit, writeBlobToPath } from "./git";
import type { LedgerReadPort } from "./ledger-port";
import { firstWord, formatQueryResult, loadQueryData, QUERY_SCHEMA_VERSION, QUERY_TABLES, QueryError, runQuery, SCHEMA_TABLE, type QuerySource } from "./query";
import { queryLedgers } from "./query-ledgers";
import { makeRelease } from "./release-store";

/** A port over a map of `<dir>/<file>` to text, the shape `gitLedgerReadPort` reads. */
function port(files: Record<string, string>): LedgerReadPort {
  const dirs = (): string[] => [...new Set(Object.keys(files).map((p) => p.slice(0, p.indexOf("/"))))];
  return {
    read: async (dir, file) => files[`${dir}/${file}`] ?? null,
    list: async (dir) => Object.keys(files).filter((p) => p.startsWith(`${dir}/`)).map((p) => p.slice(dir.length + 1)),
    trees: async () => dirs(),
  };
}

const lines = (...rows: unknown[]): string => rows.map((r) => (typeof r === "string" ? r : JSON.stringify(r))).join("\n") + "\n";

const release = makeRelease({ member: null, commit: "c".repeat(40), artifactDigests: [{ component: "api", kind: "image", path: "dist/api.tar", digest: "sha256:aa" }], targets: [{ env: "prod", templates: [], params: [] }] });

const ledger = port({
  "prod/aws.json": JSON.stringify({ lexicon: "aws", environment: "prod", commit: "a".repeat(40), timestamp: "2026-10-01T00:00:00Z", resources: { Bucket: { type: "AWS::S3::Bucket", status: "CREATE_COMPLETE", physicalId: "my-bucket", attributes: { Arn: "arn:aws:s3:::my-bucket" } }, Queue: { type: "AWS::SQS::Queue", status: "CREATE_COMPLETE" } } }),
  "prod/edge__k8s.json": JSON.stringify({ lexicon: "k8s", environment: "prod", commit: "b".repeat(40), timestamp: "2026-10-02T00:00:00Z", depth: "deep", resources: { Web: { type: "K8s::Apps::Deployment", status: "Available", ownership: "owned" } }, unobserved: { Gone: { reason: "not-found" } } }),
  "prod/observation-baseline.json": JSON.stringify({ version: 1, environment: "prod" }),
  "prod/releases.jsonl": lines(
    { version: 1, component: "api", env: "prod", digest: "sha256:aa", gitSha: "c".repeat(40), runId: "r1", runOrigin: { forge: "github", url: "https://example.test/run/1" }, timestamp: "2026-10-03T00:00:00Z", actor: "ci", releaseDigest: release.releaseDigest },
    "{not json",
  ),
  "prod/runs__deploy.jsonl": lines(
    { version: 1, id: "run-1", op: "deploy", env: "prod", started: "2026-10-03T00:00:00Z", ended: "2026-10-03T00:01:00Z", status: "fail", labels: { Env: "prod" }, outcomes: {}, phases: [], failure: { code: "command-failed", reason: "exit 1", phase: "apply" } },
    { version: 1, id: "run-2", op: "deploy", env: "prod", started: "2026-10-04T00:00:00Z", ended: "2026-10-04T00:01:00Z", status: "ok", labels: {}, outcomes: { url: "https://x" }, phases: [] },
  ),
  "_gates/deploy.jsonl": lines(
    { version: 1, kind: "pending", op: "deploy", gate: "prod-approval", timestamp: "2026-10-03T00:00:00Z", expiresAt: "2026-10-10T00:00:00Z", planDigest: "sha256:p1", origin: "cli" },
    { version: 1, op: "deploy", gate: "prod-approval", resolvedBy: "alice", timestamp: "2026-10-03T01:00:00Z", planDigest: "sha256:p1", approver: { kind: "human" } },
  ),
  [`_releases/${release.releaseDigest.replace(/:/g, "_")}.json`]: JSON.stringify(release),
  "_releases/sha256_tampered.json": JSON.stringify({ ...release, releaseDigest: "sha256:tampered" }),
  "_releases/cuts.jsonl": lines({ version: 1, releaseDigest: release.releaseDigest, label: "v1.0.0", actor: "alice", timestamp: "2026-10-02T12:00:00Z", runId: null, runOrigin: null, signature: null }),
});

describe("chant query (#4297)", () => {
  test("loads every ledger into its table and counts what it can't read", async () => {
    const load = await loadQueryData([{ member: null, port: ledger }]);
    expect(load.data.snapshots).toHaveLength(2);
    expect(load.data.resources.map((r) => r.name)).toEqual(["Bucket", "Queue", "Web"]);
    expect(load.data.resources[2]).toMatchObject({ stack: "edge", lexicon: "k8s", ownership: "owned" });
    expect(load.data.snapshots[1]).toMatchObject({ depth: "deep", resources: 1, unobserved: 1 });
    expect(load.data.runs.map((r) => r.status)).toEqual(["fail", "ok"]);
    expect(load.data.gates.map((g) => g.kind)).toEqual(["pending", "resolution"]);
    expect(load.data.deploys).toHaveLength(1);
    expect(load.data.releases).toEqual([expect.objectContaining({ release_digest: release.releaseDigest, envs: "prod" })]);
    expect(load.data.cuts[0]).toMatchObject({ label: "v1.0.0", signed: 0 });
    expect(load.malformed).toMatchObject({ deploys: 1, releases: 1, runs: 0, gates: 0 });
  });

  test("runs SQL over the tables and joins them", async () => {
    const load = await loadQueryData([{ member: null, port: ledger }]);
    const byType = await runQuery("SELECT lexicon, count(*) AS n FROM resources GROUP BY lexicon ORDER BY lexicon", load);
    expect(byType.columns).toEqual(["lexicon", "n"]);
    expect(byType.rows).toEqual([{ lexicon: "aws", n: 2 }, { lexicon: "k8s", n: 1 }]);
    const joined = await runQuery("SELECT d.component, c.label FROM deploys d JOIN cuts c ON c.release_digest = d.release_digest", load);
    expect(joined.rows).toEqual([{ component: "api", label: "v1.0.0" }]);
    const arn = await runQuery("SELECT json_extract(attributes, '$.Arn') AS arn FROM resources WHERE name = 'Bucket'", load);
    expect(arn.rows[0].arn).toBe("arn:aws:s3:::my-bucket");
    expect(arn.schemaVersion).toBe(QUERY_SCHEMA_VERSION);
    expect(formatQueryResult(arn)).toContain("(1 row)");
  });

  test("chant_schema lists every column with the schema version", async () => {
    const load = await loadQueryData([]);
    const r = await runQuery(`SELECT DISTINCT version, table_name FROM ${SCHEMA_TABLE} ORDER BY table_name`, load);
    expect(r.rows.map((x) => x.table_name)).toEqual(Object.keys(QUERY_TABLES).sort());
    expect(new Set(r.rows.map((x) => x.version))).toEqual(new Set([QUERY_SCHEMA_VERSION]));
  });

  test("each member's rows name the member", async () => {
    const load = await loadQueryData([{ member: "api", port: ledger }, { member: "web", port: port({}) }]);
    const r = await runQuery("SELECT DISTINCT member FROM runs", load);
    expect(r.rows).toEqual([{ member: "api" }]);
  });

  test("refuses anything but a read", async () => {
    const load = await loadQueryData([]);
    await expect(runQuery("DELETE FROM runs", load)).rejects.toBeInstanceOf(QueryError);
    await expect(runQuery("  ", load)).rejects.toBeInstanceOf(QueryError);
    // A WITH that writes is stopped by query_only.
    await expect(runQuery("WITH x AS (SELECT 1) INSERT INTO runs (id) SELECT * FROM x", load)).rejects.toBeInstanceOf(QueryError);
    await expect(runQuery("SELECT nope FROM runs", load)).rejects.toThrow(/does not run/);
    expect(firstWord("-- note\n /* c */ select 1")).toBe("select");
  });
});

const changeSet = composeChangeSet([
  {
    member: { member: "net", lexicon: "terraform", planner: "terraform", status: "planned", planDigest: "sha256:plan-net", holes: [] },
    entries: [
      { member: "net", lexicon: "terraform", planner: "terraform", address: "aws_vpc.main", type: "aws_vpc", action: "create", attributes: [{ path: "cidr_block", after: "10.0.0.0/16" }] },
      { member: "net", lexicon: "terraform", planner: "terraform", address: "aws_subnet.a", type: "aws_subnet", action: "delete", disruption: "destroy", attributes: [] },
    ],
  },
]);

const more = port({
  "prod/converge.jsonl": lines(
    { version: 1, id: "tick-1", op: "heal", env: "prod", timestamp: "2026-10-05T00:00:00Z", firedRuleIds: ["drift"], outcomes: [{ ruleId: "drift", action: "ran", op: "deploy" }], summary: { drifted: 1, remediated: 1, reported: 0, skippedBudget: 0, skippedFlap: 0, unobserved: 0, adopted: 0 }, log: "1 drifted, 1 remediated" },
    { version: 2, op: "heal" },
  ),
  "prod/outcomes.jsonl": lines({ version: 1, env: "prod", verb: "promote", runId: "r9", timestamp: "2026-10-06T00:00:00Z", actor: "ci", releaseDigest: null, status: "fail", components: [{ component: "api", outcome: "failed", digest: "sha256:aa", releaseDigest: null }, { component: "web", outcome: "not-run", digest: "sha256:bb", releaseDigest: null }] }),
  "_builds/sha256_m1.json": JSON.stringify({ version: 1, component: "api", createdAt: "2026-10-01T00:00:00Z", manifestDigest: "sha256:m1", contents: [{ kind: "image", path: "dist/api.tar", digest: "sha256:aa", mediaType: "application/vnd.oci.image.layout.v1.tar" }, { kind: "sbom", path: "dist/api.spdx.json", digest: "sha256:sb", subjectDigest: "sha256:aa", packageCount: 12, generator: "syft" }] }),
  "_builds/sha256_bad.json": "{",
  [`_change-sets/${changeSetFile(changeSet.digest)}`]: JSON.stringify(changeSet),
  "_change-sets/sha256_tampered.json": JSON.stringify({ ...changeSet, digest: "sha256:tampered" }),
  "_leases/task-7.jsonl": lines(
    { version: 1, event: "claim", item: "task-7", holder: "agent-a", by: "agent-a", token: "t1", acquiredAt: "2026-10-07T00:00:00Z", expiresAt: "2026-10-07T00:10:00Z", timestamp: "2026-10-07T00:00:00Z" },
    { version: 1, event: "release", item: "task-7", holder: "agent-a", by: "agent-a", token: "t1", acquiredAt: "2026-10-07T00:00:00Z", expiresAt: "2026-10-07T00:10:00Z", timestamp: "2026-10-07T00:05:00Z", outcome: "done" },
  ),
});

describe("chant query's converge, outcome, build, change-set and lease tables (#4329)", () => {
  test("loads each ledger into its table and counts what it can't read", async () => {
    const load = await loadQueryData([{ member: null, port: more }]);
    expect(load.data.converge).toEqual([expect.objectContaining({ env: "prod", id: "tick-1", op: "heal", drifted: 1, remediated: 1, gated: 0, log: "1 drifted, 1 remediated" })]);
    expect(load.data.deploy_outcomes.map((o) => [o.component, o.outcome, o.status])).toEqual([["api", "failed", "fail"], ["web", "not-run", "fail"]]);
    expect(load.data.builds).toEqual([expect.objectContaining({ manifest_digest: "sha256:m1", component: "api", artifacts: 2, legacy_digest: 0 })]);
    expect(load.data.build_artifacts[1]).toMatchObject({ kind: "sbom", subject_digest: "sha256:aa", package_count: 12, generator: "syft" });
    expect(load.data.change_sets).toEqual([expect.objectContaining({ digest: changeSet.digest, entries: 2, holes: 0 })]);
    expect(load.data.change_set_entries.map((e) => [e.address, e.action, e.plan_digest])).toEqual([["aws_subnet.a", "delete", "sha256:plan-net"], ["aws_vpc.main", "create", "sha256:plan-net"]]);
    expect(load.data.leases.map((l) => [l.event, l.written_by, l.outcome])).toEqual([["claim", "agent-a", null], ["release", "agent-a", "done"]]);
    expect(load.malformed).toMatchObject({ converge: 1, builds: 1, change_sets: 1, leases: 0, deploy_outcomes: 0 });
  });

  test("the new tables take SQL like the others", async () => {
    const load = await loadQueryData([{ member: null, port: more }]);
    const deletes = await runQuery("SELECT address, json_extract(attributes, '$') AS attrs FROM change_set_entries WHERE action = 'delete'", load);
    expect(deletes.rows).toEqual([{ address: "aws_subnet.a", attrs: "[]" }]);
    const sboms = await runQuery("SELECT b.component, a.generator FROM builds b JOIN build_artifacts a ON a.manifest_digest = b.manifest_digest WHERE a.kind = 'sbom'", load);
    expect(sboms.rows).toEqual([{ component: "api", generator: "syft" }]);
    const schema = await runQuery(`SELECT DISTINCT source FROM ${SCHEMA_TABLE}`, load);
    expect(schema.rows).toEqual([{ source: "chant" }]);
  });
});

describe("a product's own tables (#4329)", () => {
  const source = (tables: QuerySource["tables"]): QuerySource => ({ name: "terragucci", version: 3, tables });
  const inventory = source({
    inventory: { columns: [["project", "TEXT"], ["root", "TEXT"], ["address", "TEXT"], ["commit", "TEXT"], ["wave", "INTEGER"]], rows: [{ project: "core", root: "net", address: "aws_vpc.main", commit: "abc", wave: 4 }] },
  });

  test("sit beside chant's tables, join them and show in chant_schema", async () => {
    const load = await loadQueryData([{ member: null, port: more }]);
    const r = await runQuery("SELECT i.root, e.action FROM inventory i JOIN change_set_entries e ON e.address = i.address", load, { sources: [inventory] });
    expect(r.rows).toEqual([{ root: "net", action: "create" }]);
    expect(r.tables.inventory).toBe(1);
    const schema = await runQuery(`SELECT version, column_name, type FROM ${SCHEMA_TABLE} WHERE source = 'terragucci' ORDER BY position`, load, { sources: [inventory] });
    expect(schema.rows.map((x) => x.column_name)).toEqual(["project", "root", "address", "commit", "wave"]);
    expect(new Set(schema.rows.map((x) => x.version))).toEqual(new Set([3]));
  });

  test("a bare keyword column gets a hint to quote it", async () => {
    const load = await loadQueryData([]);
    await expect(runQuery("SELECT commit FROM inventory", load, { sources: [inventory] })).rejects.toThrow(/quote the column: "commit"/);
    const quoted = await runQuery('SELECT "commit" FROM inventory', load, { sources: [inventory] });
    expect(quoted.rows).toEqual([{ commit: "abc" }]);
  });

  test("refuses a table that takes a chant name or a name it can't write", async () => {
    const load = await loadQueryData([]);
    await expect(runQuery("SELECT 1", load, { sources: [source({ runs: { columns: [["id", "TEXT"]], rows: [] } })] })).rejects.toThrow(/takes the name of a chant table/);
    await expect(runQuery("SELECT 1", load, { sources: [source({ "x; DROP": { columns: [["id", "TEXT"]], rows: [] } })] })).rejects.toThrow(/not a name/);
    await expect(runQuery("SELECT 1", load, { sources: [source({ t: { columns: [["id", "BLOB" as "TEXT"]], rows: [] } })] })).rejects.toThrow(/TEXT, INTEGER or REAL/);
    await expect(runQuery("SELECT 1", load, { sources: [inventory, inventory] })).rejects.toThrow(/another source's table/);
  });
});

function git(dir: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd: dir, encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

describe("chant query --at (#4329)", () => {
  test("reads the ledger at an earlier commit, by ref or by date", async () => {
    await withTestDir(async (dir) => {
      git(dir, "init", "-q", "-b", "main");
      git(dir, "config", "user.email", "test@chant.dev");
      git(dir, "config", "user.name", "Test");
      writeFileSync(join(dir, "README.md"), "fixture\n");
      git(dir, "add", ".");
      git(dir, "commit", "-q", "-m", "init");
      const run = (id: string, started: string) => ({ version: 1, id, op: "deploy", env: "prod", started, ended: started, status: "ok", labels: {}, outcomes: {}, phases: [] });
      await writeBlobToPath("prod", "runs__deploy.jsonl", lines(run("run-1", "2026-10-01T00:00:00Z")), "one run", { cwd: dir });
      await writeBlobToPath("prod", "runs__deploy.jsonl", lines(run("run-1", "2026-10-01T00:00:00Z"), run("run-2", "2026-10-02T00:00:00Z")), "two runs", { cwd: dir });
      const count = async (at?: string): Promise<unknown> => {
        const { ledgers } = await queryLedgers(dir, at === undefined ? {} : { at });
        return (await runQuery("SELECT count(*) AS n FROM runs", await loadQueryData(ledgers))).rows[0].n;
      };
      expect(await count()).toBe(2);
      expect(await count("chant/lifecycle~1")).toBe(1);
      const first = git(dir, "rev-parse", "chant/lifecycle~1");
      expect(await resolveLedgerCommit(first.slice(0, 10), { cwd: dir })).toBe(first);
      expect(await count("2099-01-01")).toBe(2);
      // A commit of main is not on the ledger, and a date before the first ledger commit names nothing.
      expect(await resolveLedgerCommit("main", { cwd: dir })).toBeNull();
      await expect(queryLedgers(dir, { at: "2000-01-01" })).rejects.toThrow(/names no commit of chant\/lifecycle/);
    });
  });
});
