import { describe, expect, test } from "vitest";
import type { LedgerReadPort } from "./ledger-port";
import { firstWord, formatQueryResult, loadQueryData, QUERY_SCHEMA_VERSION, QUERY_TABLES, QueryError, runQuery, SCHEMA_TABLE } from "./query";
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
