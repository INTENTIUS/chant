import { describe, expect, test } from "vitest";
import type { LedgerReadPort } from "./ledger-port";
import { firstWord, formatQueryResult, loadQueryData, QUERY_OWNERSHIP_COLUMNS_FLOOR, QUERY_SCHEMA_VERSION, QUERY_TABLES, QueryError, runQuery, SCHEMA_TABLE } from "./query";
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

  describe("ownership columns on resources (#4534)", () => {
    // A choudoufu live root read through the terraform lexicon, and a k8s
    // root whose labels name the stack and env. Engine facts are the
    // snapshot's `facts`; chant's marker is its `marker`.
    const owned = port({
      "prod/estate__terraform.json": JSON.stringify({
        lexicon: "terraform",
        environment: "prod",
        commit: "d".repeat(40),
        timestamp: "2026-10-26T00:00:00Z",
        resources: {
          "aws_s3_bucket.logs": { type: "aws_s3_bucket", status: "bound", physicalId: "acme-logs", ownership: "owned", marker: { stack: "acme", env: "aws_s3_bucket.logs" }, facts: { ownership: "bound", ownedBy: "marker" } },
          "aws_sqs_queue.jobs": { type: "aws_sqs_queue", status: "unowned", ownership: "foreign", facts: { ownership: "unowned" } },
          "aws_eip.pool": { type: "aws_eip", status: "bound", ownership: "owned", facts: { ownership: "bound", ownedBy: "record" } },
        },
      }),
      "prod/shop__k8s.json": JSON.stringify({
        lexicon: "k8s",
        environment: "prod",
        commit: "e".repeat(40),
        timestamp: "2026-10-26T00:00:00Z",
        resources: { web: { type: "K8s::Apps::Deployment", status: "Available", physicalId: "default/web", ownership: "owned", marker: { stack: "shop", env: "prod" } } },
      }),
    });

    test("are listed in schema v1, after the existing columns", async () => {
      const cols = QUERY_TABLES.resources.map(([c]) => c);
      expect(cols.slice(0, 13)).toEqual(["member", "env", "stack", "lexicon", "name", "type", "physical_id", "status", "last_updated", "ownership", "attributes", "git_sha", "observed_at"]);
      expect(cols.slice(13)).toEqual(["marker_stack", "marker_env", "engine_ownership", "engine_owned_by"]);
      const load = await loadQueryData([]);
      const r = await runQuery(`SELECT column_name, version FROM ${SCHEMA_TABLE} WHERE table_name = 'resources' AND column_name IN ('ownership', 'marker_stack', 'marker_env', 'engine_ownership', 'engine_owned_by') ORDER BY position`, load);
      expect(r.rows.map((x) => x.column_name)).toEqual(["ownership", "marker_stack", "marker_env", "engine_ownership", "engine_owned_by"]);
      expect(new Set(r.rows.map((x) => x.version))).toEqual(new Set([1]));
    });

    test("project the snapshot's marker and engine facts, NULL when unknown", async () => {
      const load = await loadQueryData([{ member: null, port: owned }]);
      const by = Object.fromEntries(load.data.resources.map((r) => [r.name, r]));
      expect(by["aws_s3_bucket.logs"]).toMatchObject({ ownership: "owned", marker_stack: "acme", marker_env: "aws_s3_bucket.logs", engine_ownership: "bound", engine_owned_by: "marker" });
      expect(by["aws_sqs_queue.jobs"]).toMatchObject({ ownership: "foreign", marker_stack: null, marker_env: null, engine_ownership: "unowned", engine_owned_by: null });
      expect(by.web).toMatchObject({ lexicon: "k8s", ownership: "owned", marker_stack: "shop", marker_env: "prod", engine_ownership: null, engine_owned_by: null });
    });

    test("are NULL on a snapshot that predates them", async () => {
      const load = await loadQueryData([{ member: null, port: ledger }]);
      for (const r of load.data.resources) {
        expect(r).toMatchObject({ marker_stack: null, marker_env: null, engine_ownership: null, engine_owned_by: null });
      }
    });

    test("count by both verdicts without the graph peer", async () => {
      const load = await loadQueryData([{ member: null, port: owned }]);
      const r = await runQuery("SELECT lexicon, ownership, engine_ownership, count(*) AS n FROM resources GROUP BY 1, 2, 3 ORDER BY 1, 2, 3", load);
      expect(r.rows).toEqual([
        { lexicon: "k8s", ownership: "owned", engine_ownership: null, n: 1 },
        { lexicon: "terraform", ownership: "foreign", engine_ownership: "unowned", n: 1 },
        { lexicon: "terraform", ownership: "owned", engine_ownership: "bound", n: 2 },
      ]);
      const who = await runQuery("SELECT stack, name, marker_stack FROM resources WHERE physical_id = 'default/web'", load);
      expect(who.rows).toEqual([{ stack: "shop", name: "web", marker_stack: "shop" }]);
    });

    test("carry their floor at 0.124.54, where they shipped", () => {
      expect(QUERY_OWNERSHIP_COLUMNS_FLOOR).toBe("0.124.54");
    });
  });
});
