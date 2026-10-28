/**
 * Release status records (#4596): append, the latest line per digest wins,
 * the member prefix, `--no-record`, and `chant ledger release_status`
 * listing the table.
 */
import { afterEach, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gitLedgerReadPort } from "./git";
import { readLedgerTable } from "./ledger-read";
import { clearMemberLedgerCache } from "./member-ledger";
import { resetNoRecordLedger } from "./no-record";
import { LEDGER_RELEASE_STATUS_FLOOR, loadQueryData, QUERY_TABLES } from "./query";
import { buildReleaseCatalog } from "./release-catalog";
import type { ReleaseRecord } from "./release-ledger";
import {
  appendReleaseStatus,
  catalogStatusInputs,
  parseReleaseStatus,
  readReleaseStatus,
  readReleaseStatusOn,
  RELEASE_STATUS_FLOOR,
  ReleaseStatusError,
  statusOf,
  type ReleaseStatusInput,
} from "./release-status";

const scratch: string[] = [];
afterEach(() => {
  delete process.env.CHANT_NO_RECORD;
  resetNoRecordLedger();
  clearMemberLedgerCache();
  for (const d of scratch.splice(0)) rmSync(d, { recursive: true, force: true });
});

function git(args: string[], cwd: string): string {
  return execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function repo(files: Record<string, string> = { "README.md": "fixture\n" }): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "chant-release-status-")));
  scratch.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  git(["init", "-q", "-b", "main"], root);
  git(["config", "user.email", "test@chant.dev"], root);
  git(["config", "user.name", "Test"], root);
  git(["add", "-A"], root);
  git(["commit", "-q", "-m", "init"], root);
  return root;
}

function branchFiles(root: string): string[] {
  try {
    return git(["ls-tree", "-r", "--name-only", "chant/lifecycle"], root).split("\n").filter(Boolean).sort();
  } catch {
    return [];
  }
}

const status = (over: Partial<ReleaseStatusInput> = {}): ReleaseStatusInput => ({
  component: "vpc/aws",
  env: "registry",
  digest: "sha256:v2",
  releaseVersion: "2.0.0",
  status: "deprecated",
  reason: "use 2.1.0",
  replacement: "2.1.0",
  actor: "ana",
  timestamp: "2026-10-20T00:00:00.000Z",
  ...over,
});

describe("release status floors", () => {
  test("shipped in 0.124.55", () => {
    expect(RELEASE_STATUS_FLOOR).toBe("0.124.55");
    expect(LEDGER_RELEASE_STATUS_FLOOR).toBe("0.124.55");
  });
});

describe("appendReleaseStatus (#4596)", () => {
  test("refuses a record the reader would skip, before any git runs", async () => {
    await expect(appendReleaseStatus(status({ status: "gone" as never }), { cwd: "/nonexistent" })).rejects.toBeInstanceOf(ReleaseStatusError);
    await expect(appendReleaseStatus(status({ actor: "" }), { cwd: "/nonexistent" })).rejects.toBeInstanceOf(ReleaseStatusError);
    await expect(appendReleaseStatus(status({ reason: "" }), { cwd: "/nonexistent" })).rejects.toBeInstanceOf(ReleaseStatusError);
  });

  test("appends one line beside releases.jsonl and reads it back", async () => {
    const root = repo();
    const { record } = await appendReleaseStatus(status(), { cwd: root });
    expect(record.version).toBe(1);
    expect(branchFiles(root)).toEqual(["registry/release-status.jsonl"]);
    const { records, malformed } = await readReleaseStatus("registry", { cwd: root });
    expect(malformed).toBe(0);
    expect(records).toEqual([record]);
  });

  test("the latest line per digest wins, and a restore is one more line", async () => {
    const root = repo();
    await appendReleaseStatus(status({ status: "yanked", timestamp: "2026-10-20T00:00:00.000Z" }), { cwd: root });
    await appendReleaseStatus(status({ status: "active", reason: "fixed upstream", replacement: undefined, actor: "bo", timestamp: "2026-10-21T00:00:00.000Z" }), { cwd: root });
    await appendReleaseStatus(status({ digest: "sha256:v1", releaseVersion: "1.0.0", status: "deprecated", timestamp: "2026-10-21T00:00:00.000Z" }), { cwd: root });
    const { records } = await readReleaseStatus("registry", { cwd: root });
    expect(records).toHaveLength(3);
    expect(statusOf(records, "vpc/aws", "sha256:v2")).toMatchObject({ status: "active", record: { actor: "bo" } });
    expect(statusOf(records, "vpc/aws", "sha256:v1").status).toBe("deprecated");
    expect(statusOf(records, "vpc/aws", "sha256:never")).toEqual({ status: "active" });
    expect(statusOf(records, "other", "sha256:v2")).toEqual({ status: "active" });
  });

  test("a tie in time goes to the later line", () => {
    const lines = [status({ status: "yanked" }), status({ status: "deprecated" })].map((s) => JSON.stringify({ version: 1, ...s })).join("\n");
    expect(statusOf(parseReleaseStatus(lines).records, "vpc/aws", "sha256:v2").status).toBe("deprecated");
  });

  test("a malformed line is counted and skipped", () => {
    const good = JSON.stringify({ version: 1, ...status() });
    const { records, malformed } = parseReleaseStatus(`${good}\n{\n${JSON.stringify({ version: 2, ...status() })}\n${JSON.stringify({ version: 1, ...status({ status: "gone" as never }) })}\n`);
    expect(records).toHaveLength(1);
    expect(malformed).toBe(3);
  });

  test("writes under the member prefix of cwd", async () => {
    const CONFIG = JSON.stringify({ lexicons: ["terraform"] });
    const root = repo({
      "chant.workspace.json": JSON.stringify({ name: "acme", schema: 1, members: [{ name: "modules", dir: "modules", kind: "chant" }] }),
      "modules/chant.config.json": CONFIG,
    });
    await appendReleaseStatus(status(), { cwd: join(root, "modules") });
    expect(branchFiles(root)).toEqual(["_members/modules/registry/release-status.jsonl"]);
    expect((await readReleaseStatus("registry", { cwd: join(root, "modules") })).records).toHaveLength(1);
    expect((await readReleaseStatus("registry", { cwd: root, member: "modules" })).records).toHaveLength(1);
    expect((await readReleaseStatus("registry", { cwd: root })).records).toEqual([]);
  });

  test("with --no-record the line reads back in process and the branch is unchanged", async () => {
    const root = repo();
    process.env.CHANT_NO_RECORD = "1";
    await appendReleaseStatus(status(), { cwd: root });
    expect((await readReleaseStatus("registry", { cwd: root })).records).toHaveLength(1);
    expect(branchFiles(root)).toEqual([]);
  });
});

describe("the release_status table (#4596)", () => {
  test("chant query loads every line", async () => {
    const root = repo();
    await appendReleaseStatus(status({ status: "yanked" }), { cwd: root });
    await appendReleaseStatus(status({ status: "active", reason: undefined, replacement: undefined, releaseVersion: undefined, timestamp: "2026-10-22T00:00:00.000Z" }), { cwd: root });
    const { data, malformed } = await loadQueryData([{ member: null, port: gitLedgerReadPort({ cwd: root }) }]);
    expect(malformed.release_status).toBe(0);
    expect(QUERY_TABLES.release_status.map(([c]) => c)).toEqual(["member", "env", "component", "digest", "release_version", "status", "reason", "replacement", "actor", "timestamp"]);
    expect(data.release_status).toEqual([
      { member: null, env: "registry", component: "vpc/aws", digest: "sha256:v2", release_version: "2.0.0", status: "yanked", reason: "use 2.1.0", replacement: "2.1.0", actor: "ana", timestamp: "2026-10-20T00:00:00.000Z" },
      { member: null, env: "registry", component: "vpc/aws", digest: "sha256:v2", release_version: null, status: "active", reason: null, replacement: null, actor: "ana", timestamp: "2026-10-22T00:00:00.000Z" },
    ]);
  });

  test("chant ledger release_status lists it, filtered", async () => {
    const root = repo();
    await appendReleaseStatus(status({ status: "yanked" }), { cwd: root });
    await appendReleaseStatus(status({ digest: "sha256:v1", releaseVersion: "1.0.0" }), { cwd: root });
    const doc = await readLedgerTable("release_status", [{ member: null, port: gitLedgerReadPort({ cwd: root }) }], { where: ["status=yanked"] });
    if (!("rows" in doc)) throw new Error(JSON.stringify(doc));
    expect(doc.table).toBe("release_status");
    expect(doc.total).toBe(2);
    expect(doc.rows.map((r) => r.digest)).toEqual(["sha256:v2"]);
  });
});

describe("catalogStatusInputs", () => {
  test("feeds the release catalog", async () => {
    const root = repo();
    await appendReleaseStatus(status({ status: "yanked", reason: "breaks routes" }), { cwd: root });
    const { records } = await readReleaseStatusOn(gitLedgerReadPort({ cwd: root }), "registry");
    const release: ReleaseRecord = { version: 1, component: "vpc/aws", env: "registry", digest: "sha256:v2", releaseVersion: "2.0.0", gitSha: "a".repeat(40), runId: "r1", timestamp: "2026-10-01T00:00:00.000Z", actor: "ci" };
    const catalog = buildReleaseCatalog({ releases: [release], statuses: catalogStatusInputs(records) }, { generatedAt: "2026-10-27T00:00:00.000Z" });
    expect(catalog.components[0].versions[0].status).toMatchObject({ state: "yanked", reason: "breaks routes", replacement: "2.1.0" });
    expect(catalog.components[0].latest).toBeNull();
  });
});
