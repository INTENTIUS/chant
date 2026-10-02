/**
 * #2538 — member ledgers under `_members/<member>/` on `chant/lifecycle`.
 *
 * One fixture workspace holds a root member `.`, two members `api` and `web`
 * that use the same environment name, an example group, and a nested
 * workspace `platform` with a member `core`. Each store is written from a
 * member's directory and the exact branch path is asserted, then read back
 * from each member to show neither sees the other's records.
 */

import { afterAll, beforeEach, describe, expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { clearMemberLedgerCache, memberLedgerPrefix, MemberLedgerError, resolveMemberLedger } from "./member-ledger";
import { ledgerDir, listLedgerEnvironments, listSnapshots, readEnvironmentSnapshots, writeLedgerFiles, writeSnapshot } from "./git";
import { appendReleaseRecord, readReleaseLedger, type ReleaseRecordInput } from "./release-ledger";
import { appendRunRecord, readRunLedger } from "./run-ledger";
import type { OpRunRecordInput } from "../op/runtime";
import { appendConvergeRecord, readConvergeLedger, type ConvergeTickRecordInput } from "./converge-ledger";
import { appendGateResolution, appendPendingGate, gateLedgerPath, readGateLedger } from "./gate-ledger";
import { persistBuildManifest, listBuildManifestDigests } from "./build-ledger-store";
import { emptyBaseline, readObservationBaseline, writeObservationBaseline } from "./observation-baseline";
import { acquireLease, leaseRef, readLease } from "./lease";
import { createBuildArchiveManifest } from "../components/verbs/build-archive";

const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});
beforeEach(() => clearMemberLedgerCache());

function git(args: string[], cwd: string): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

function repo(files: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "chant-member-ledger-")));
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

const CONFIG = JSON.stringify({ lexicons: ["k8s"] });

function workspace(): string {
  return repo({
    "chant.workspace.json": JSON.stringify({
      name: "acme",
      schema: 1,
      members: [
        { name: "root", dir: ".", kind: "chant" },
        { name: "api", dir: "services/api", kind: "chant" },
        { name: "web", dir: "services/web", kind: "chant" },
        { name: "platform", dir: "platform", kind: "workspace" },
        { name: "examples", kind: "examples", glob: "examples/*" },
      ],
    }),
    "chant.config.json": CONFIG,
    "services/api/chant.config.json": CONFIG,
    "services/api/src/main.ts": "",
    "services/web/chant.config.json": CONFIG,
    "examples/demo/chant.config.json": CONFIG,
    "docs/README.md": "",
    "platform/chant.workspace.json": JSON.stringify({
      name: "platform",
      schema: 1,
      members: [{ name: "core", dir: "core", kind: "chant" }],
    }),
    "platform/core/chant.config.json": CONFIG,
  });
}

/** Every file on chant/lifecycle, sorted. */
function branchFiles(root: string): string[] {
  return git(["ls-tree", "-r", "--name-only", "chant/lifecycle"], root).split("\n").filter(Boolean).sort();
}

function release(overrides: Partial<ReleaseRecordInput> = {}): ReleaseRecordInput {
  return {
    component: "svc",
    env: "prod",
    digest: "sha256:abc",
    gitSha: "deadbeef",
    runId: "run-1",
    timestamp: "2026-01-01T00:00:00.000Z",
    actor: "ci",
    ...overrides,
  };
}

function run(overrides: Partial<OpRunRecordInput> = {}): OpRunRecordInput {
  return {
    op: "deploy",
    env: "prod",
    started: "2026-01-01T00:00:00.000Z",
    ended: "2026-01-01T00:00:01.000Z",
    status: "ok",
    labels: { Env: "prod" },
    outcomes: {},
    phases: [],
    ...overrides,
  };
}

function tick(overrides: Partial<ConvergeTickRecordInput> = {}): ConvergeTickRecordInput {
  return {
    op: "converge",
    env: "prod",
    timestamp: "2026-01-01T00:00:00.000Z",
    firedRuleIds: [],
    outcomes: [],
    summary: { drifted: 0, remediated: 0, reported: 0, skippedBudget: 0, skippedFlap: 0, unobserved: 0, adopted: 0 },
    log: "converge(prod)",
    ...overrides,
  };
}

describe("resolveMemberLedger (#2538)", () => {
  test("a project with no declaration keeps the flat layout", async () => {
    const root = repo({ "chant.config.json": CONFIG });
    expect(await resolveMemberLedger(root)).toEqual({ members: [], prefix: "" });
  });

  test("the root member, unowned directories and example matches keep the flat layout", async () => {
    const root = workspace();
    for (const dir of [".", "docs", "examples/demo"]) {
      expect((await resolveMemberLedger(join(root, dir))).prefix, dir).toBe("");
    }
  });

  test("a member, and any directory inside it, writes under _members/<member>/", async () => {
    const root = workspace();
    expect(await resolveMemberLedger(join(root, "services/api"))).toEqual({ members: ["api"], prefix: "_members/api/" });
    expect((await resolveMemberLedger(join(root, "services/api/src"))).prefix).toBe("_members/api/");
    expect((await resolveMemberLedger(join(root, "services/web"))).prefix).toBe("_members/web/");
  });

  test("a nested workspace's ledgers sit inside the outer member that holds it", async () => {
    const root = workspace();
    expect((await resolveMemberLedger(join(root, "platform"))).prefix).toBe("_members/platform/");
    expect(await resolveMemberLedger(join(root, "platform/core"))).toEqual({
      members: ["platform", "core"],
      prefix: "_members/platform/_members/core/",
    });
  });

  test("an unreadable declaration refuses to place the ledger rather than guess", async () => {
    const root = repo({ "chant.workspace.json": "{ not json", "api/chant.config.json": CONFIG });
    await expect(resolveMemberLedger(join(root, "api"))).rejects.toBeInstanceOf(MemberLedgerError);
    await expect(ledgerDir("prod", { cwd: join(root, "api") })).rejects.toThrow(/cannot place this project's lifecycle ledger/);
  });

  test("memberLedgerPrefix joins one _members/<name>/ per level", () => {
    expect(memberLedgerPrefix([])).toBe("");
    expect(memberLedgerPrefix(["a", "b"])).toBe("_members/a/_members/b/");
  });
});

describe("every lifecycle store writes under the member path (#2538)", () => {
  test("releases: two members with one environment name keep separate ledgers", async () => {
    const root = workspace();
    const api = join(root, "services/api");
    const web = join(root, "services/web");
    await appendReleaseRecord(release({ component: "api" }), { cwd: api });
    await appendReleaseRecord(release({ component: "web" }), { cwd: web });
    await appendReleaseRecord(release({ component: "root" }), { cwd: root });

    expect(branchFiles(root)).toEqual(["_members/api/prod/releases.jsonl", "_members/web/prod/releases.jsonl", "prod/releases.jsonl"]);
    expect((await readReleaseLedger("prod", { cwd: api })).records.map((r) => r.component)).toEqual(["api"]);
    expect((await readReleaseLedger("prod", { cwd: web })).records.map((r) => r.component)).toEqual(["web"]);
    expect((await readReleaseLedger("prod", { cwd: root })).records.map((r) => r.component)).toEqual(["root"]);
    expect(await listLedgerEnvironments({ cwd: api })).toEqual(["prod"]);
    // The root member's listing never reads `_members` as an environment.
    expect(await listLedgerEnvironments({ cwd: root })).toEqual(["prod"]);
  });

  test("snapshots and observation baselines", async () => {
    const root = workspace();
    const api = join(root, "services/api");
    const web = join(root, "services/web");
    await writeSnapshot("prod", "k8s", '{"from":"api"}', { cwd: api });
    await writeSnapshot("prod", "k8s", '{"from":"web"}', { cwd: web });
    await writeObservationBaseline(emptyBaseline("prod"), { cwd: api });

    const files = branchFiles(root);
    expect(files).toContain("_members/api/prod/k8s.json");
    expect(files).toContain("_members/web/prod/k8s.json");
    expect(files.filter((f) => f.startsWith("_members/api/prod/") && f !== "_members/api/prod/k8s.json")).toHaveLength(1);
    expect(files.every((f) => f.startsWith("_members/"))).toBe(true);
    expect([...(await readEnvironmentSnapshots("prod", { cwd: web })).values()]).toEqual(['{"from":"web"}']);
    expect(await readObservationBaseline("prod", { cwd: api })).toMatchObject({ environment: "prod" });
    expect(await readObservationBaseline("prod", { cwd: web })).toBeNull();
    // A member's history lists only the commits that touched its ledger.
    expect(await listSnapshots({ cwd: web })).toHaveLength(1);
    expect(await listSnapshots({ cwd: root })).toHaveLength(3);
  });

  test("runs and converge records", async () => {
    const root = workspace();
    const api = join(root, "services/api");
    const web = join(root, "services/web");
    await appendRunRecord(run(), { cwd: api });
    await appendConvergeRecord(tick(), { cwd: web });

    expect(branchFiles(root)).toEqual(["_members/api/prod/runs__deploy.jsonl", "_members/web/prod/converge.jsonl"]);
    expect((await readRunLedger("prod", "deploy", { cwd: api })).records).toHaveLength(1);
    expect((await readRunLedger("prod", "deploy", { cwd: web })).records).toHaveLength(0);
    expect((await readConvergeLedger("prod", { cwd: web })).records).toHaveLength(1);
    expect((await readConvergeLedger("prod", { cwd: api })).records).toHaveLength(0);
  });

  test("gates: _gates moves under the member, and an Op name can repeat across members", async () => {
    const root = workspace();
    const api = join(root, "services/api");
    const web = join(root, "services/web");
    await appendPendingGate({ op: "deploy", gate: "approve", timestamp: "2026-01-01T00:00:00.000Z", expiresAt: "2026-01-02T00:00:00.000Z" }, { cwd: api });
    await appendGateResolution({ op: "deploy", gate: "approve", resolvedBy: "alex", timestamp: "2026-01-01T00:00:01.000Z" }, { cwd: web });

    expect(branchFiles(root)).toEqual(["_members/api/_gates/deploy.jsonl", "_members/web/_gates/deploy.jsonl"]);
    const apiGates = await readGateLedger("deploy", { cwd: api });
    expect(apiGates.pending).toHaveLength(1);
    expect(apiGates.resolutions).toHaveLength(0);
    const webGates = await readGateLedger("deploy", { cwd: web });
    expect(webGates.pending).toHaveLength(0);
    expect(webGates.resolutions).toHaveLength(1);
    expect(gateLedgerPath("deploy", "_members/api/")).toBe("_members/api/_gates/deploy.jsonl");
    expect(gateLedgerPath("deploy")).toBe("_gates/deploy.jsonl");
  });

  test("build records: _builds moves under the member", async () => {
    const root = workspace();
    const api = join(root, "services/api");
    const manifest = createBuildArchiveManifest("api", { now: () => new Date("2026-01-01T00:00:00.000Z") });
    await persistBuildManifest(manifest, { cwd: api });

    const files = branchFiles(root);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^_members\/api\/_builds\/sha256_[0-9a-f]+\.json$/);
    expect(await listBuildManifestDigests({ cwd: api })).toEqual([manifest.manifestDigest]);
    expect(await listBuildManifestDigests({ cwd: join(root, "services/web") })).toEqual([]);
  });

  test("leases: refs/chant/lease/_members/<member>/<op>, so two members' Ops of one name hold separate leases", async () => {
    const root = workspace();
    const api = join(root, "services/api");
    const web = join(root, "services/web");
    expect((await acquireLease("converge", "holder-api", { cwd: api })).acquired).toBe(true);
    expect((await acquireLease("converge", "holder-web", { cwd: web })).acquired).toBe(true);
    expect((await acquireLease("converge", "holder-root", { cwd: root })).acquired).toBe(true);

    const refs = git(["for-each-ref", "--format=%(refname)", "refs/chant/lease/"], root).split("\n").filter(Boolean).sort();
    expect(refs).toEqual([
      "refs/chant/lease/_members/api/converge",
      "refs/chant/lease/_members/web/converge",
      "refs/chant/lease/converge",
    ]);
    expect((await readLease("converge", { cwd: api })).record?.holder).toBe("holder-api");
    expect((await readLease("converge", { cwd: web })).record?.holder).toBe("holder-web");
    expect(leaseRef("converge", "_members/api/")).toBe("refs/chant/lease/_members/api/converge");
  });

  test("a nested workspace member writes under both levels", async () => {
    const root = workspace();
    await appendReleaseRecord(release({ component: "core" }), { cwd: join(root, "platform/core") });
    expect(branchFiles(root)).toEqual(["_members/platform/_members/core/prod/releases.jsonl"]);
  });
});

describe("one commit can write several members (#2538)", () => {
  test("writeLedgerFiles lands two members' records in a single commit, each read back by its own member", async () => {
    const root = workspace();
    const api = join(root, "services/api");
    const web = join(root, "services/web");
    // An earlier write, so the multi-member commit extends a branch that has other entries.
    await appendReleaseRecord(release({ component: "root" }), { cwd: root });
    const before = git(["rev-parse", "chant/lifecycle"], root).trim();

    const line = (component: string) => JSON.stringify({ version: 1, ...release({ component }) });
    const commit = await writeLedgerFiles(
      [
        { path: `${await ledgerDir("prod", { cwd: api })}/releases.jsonl`, content: line("api") },
        { path: `${await ledgerDir("prod", { cwd: web })}/releases.jsonl`, content: line("web") },
      ],
      "Release records: api, web",
      { cwd: root },
    );

    expect(git(["rev-parse", "chant/lifecycle"], root).trim()).toBe(commit);
    expect(git(["rev-parse", `${commit}^`], root).trim()).toBe(before);
    expect(git(["diff-tree", "-r", "--name-only", "--no-commit-id", commit], root).split("\n").filter(Boolean).sort()).toEqual([
      "_members/api/prod/releases.jsonl",
      "_members/web/prod/releases.jsonl",
    ]);
    expect((await readReleaseLedger("prod", { cwd: api })).records.map((r) => r.component)).toEqual(["api"]);
    expect((await readReleaseLedger("prod", { cwd: web })).records.map((r) => r.component)).toEqual(["web"]);
    expect((await readReleaseLedger("prod", { cwd: root })).records.map((r) => r.component)).toEqual(["root"]);
  });

  test("an expected prior sha that moved is a conflict, not a blind overwrite", async () => {
    const root = workspace();
    const api = join(root, "services/api");
    await appendReleaseRecord(release({ component: "api" }), { cwd: api });
    await expect(
      writeLedgerFiles([{ path: "_members/api/prod/releases.jsonl", content: "{}", expectPriorSha: null }], "stale", { cwd: root }),
    ).rejects.toThrow(/target path changed concurrently/);
  });
});
