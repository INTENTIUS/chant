/**
 * #3865 — the readers a product uses for a workspace member's release
 * environments and op-waves `_wave-plans` records: pure over a port, and the
 * git port over a member's prefix.
 */
import { afterAll, describe, expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LedgerReadPort } from "./ledger-port";
import { gitLedgerReadPort, listLedgerEnvironments, writeLedgerFiles } from "./git";
import { listReleaseEnvironmentsOn, parseReleaseLedger, readReleaseRecords } from "./release-read";
import { listReleaseEnvironments, readReleaseLedger } from "./release-ledger";
import { listWavePlanSpecs, parseHeadPlans, readAllHeadPlans, readHeadPlanDigests, readHeadPlans } from "./wave-plans";

/** A port over a flat map of `<dir>/<file>` to text. */
function memoryPort(files: Record<string, string>): LedgerReadPort {
  return {
    read: async (dir, file) => files[`${dir}/${file}`] ?? null,
    list: async (dir) => [...new Set(Object.keys(files).filter((p) => p.startsWith(`${dir}/`)).map((p) => p.slice(dir.length + 1).split("/")[0]))],
    trees: async () => [...new Set(Object.keys(files).map((p) => p.split("/")[0]))],
  };
}

const record = (env: string, digest = "sha256:" + "a".repeat(64)) =>
  JSON.stringify({ version: 1, component: "svc", env, digest, gitSha: "abc", runId: "r1", timestamp: "2026-01-01T00:00:00.000Z", actor: "ci" });

const plans = (head: string, digests: string[]) =>
  JSON.stringify({ version: 1, name: "ship", head, timestamp: "2026-01-01T00:00:00.000Z", waves: digests.map((digest, i) => ({ wave: i + 1, name: `w${i + 1}`, digest })) });

describe("release readers over a port", () => {
  test("list the environments that hold a ledger, sorted, and parse their records", async () => {
    const port = memoryPort({
      "staging/releases.jsonl": record("staging") + "\n",
      "prod/releases.jsonl": record("prod") + "\nnot json\n" + JSON.stringify({ version: 1 }) + "\n",
      "prod/snapshot.json": "{}",
      "_gates/deploy.jsonl": "",
    });
    expect(await listReleaseEnvironmentsOn(port)).toEqual(["prod", "staging"]);
    const { records, malformed } = await readReleaseRecords(port, "prod");
    expect(records.map((r) => r.env)).toEqual(["prod"]);
    expect(malformed).toBe(2);
    expect(await readReleaseRecords(port, "nope")).toEqual({ records: [], malformed: 0 });
  });

  test("parseReleaseLedger skips a non-object line", () => {
    expect(parseReleaseLedger(["null", "3"]).malformed).toBe(2);
  });
});

describe("wave plans readers", () => {
  const files = {
    "_wave-plans/ship/aaa.json": plans("aaa", ["sha256:one", "sha256:two"]),
    "_wave-plans/ship/bbb.json": plans("bbb", ["sha256:three"]),
    "_wave-plans/ship/broken.json": "{",
    "_wave-plans/other/ccc.json": plans("ccc", ["sha256:four"]),
  };

  test("read one head, and null for a missing or unreadable one", async () => {
    const port = memoryPort(files);
    expect((await readHeadPlans(port, "ship", "aaa"))?.waves.map((w) => w.digest)).toEqual(["sha256:one", "sha256:two"]);
    expect(await readHeadPlans(port, "ship", "zzz")).toBeNull();
    expect(await readHeadPlans(port, "ship", "broken")).toBeNull();
  });

  test("read every head of a spec, by head, with the digests by wave", async () => {
    const port = memoryPort(files);
    expect([...(await readAllHeadPlans(port, "ship")).keys()]).toEqual(["aaa", "bbb"]);
    const digests = await readHeadPlanDigests(port, "ship");
    expect(digests.get("aaa")!.get(2)).toBe("sha256:two");
    expect(digests.get("bbb")!.get(1)).toBe("sha256:three");
    expect(await listWavePlanSpecs(port)).toEqual(["other", "ship"]);
  });

  test("the parser refuses a record of another shape", () => {
    expect(parseHeadPlans(null)).toBeNull();
    expect(parseHeadPlans("[]")).toBeNull();
    expect(parseHeadPlans(JSON.stringify({ version: 2, name: "a", head: "b", timestamp: "t", waves: [] }))).toBeNull();
    expect(parseHeadPlans(JSON.stringify({ version: 1, name: "a", head: "b", timestamp: "t", waves: [{ wave: "1", name: "x", digest: "d" }] }))).toBeNull();
  });
});

describe("a member's records on chant/lifecycle", () => {
  const scratch: string[] = [];
  afterAll(() => {
    for (const d of scratch) rmSync(d, { recursive: true, force: true });
  });

  async function fixture(): Promise<string> {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "chant-ledger-readers-")));
    scratch.push(root);
    const git = (...args: string[]) => {
      const r = spawnSync("git", args, { cwd: root, encoding: "utf-8" });
      if (r.status !== 0) throw new Error(r.stderr);
    };
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@chant.dev");
    git("config", "user.name", "T");
    writeFileSync(join(root, "f"), "");
    git("add", "-A");
    git("commit", "-q", "-m", "init");
    await writeLedgerFiles(
      [
        { path: "_members/api/prod/releases.jsonl", content: record("prod") + "\n" },
        { path: "_members/api/staging/releases.jsonl", content: record("staging") + "\n" },
        { path: "_members/web/edge/releases.jsonl", content: record("edge") + "\n" },
        { path: "_members/api/_wave-plans/ship/aaa.json", content: plans("aaa", ["sha256:one"]) },
        { path: "_members/web/_wave-plans/ship/bbb.json", content: plans("bbb", ["sha256:two"]) },
        { path: "legacy/releases.jsonl", content: record("legacy") + "\n" },
      ],
      "seed",
      { cwd: root },
    );
    return root;
  }

  test("listReleaseEnvironments and readReleaseLedger take a member or its prefix, from outside it", async () => {
    const cwd = await fixture();
    expect(await listReleaseEnvironments({ cwd, member: "api" })).toEqual(["prod", "staging"]);
    expect(await listReleaseEnvironments({ cwd, ledgerPrefix: "_members/web/" })).toEqual(["edge"]);
    expect(await listReleaseEnvironments({ cwd, member: "." })).toEqual(["legacy"]);
    expect(await listLedgerEnvironments({ cwd })).toEqual(["legacy"]);
    expect((await readReleaseLedger("prod", { cwd, member: "api" })).records).toHaveLength(1);
    expect((await readReleaseLedger("prod", { cwd, member: "web" })).records).toHaveLength(0);
    expect((await readReleaseLedger("prod", { cwd, ledgerPrefix: "_members/api/" })).records).toHaveLength(1);
  });

  test("the git port reads each member's wave plans and nothing of another's", async () => {
    const cwd = await fixture();
    const api = gitLedgerReadPort({ cwd, member: "api" });
    const web = gitLedgerReadPort({ cwd, member: ["web"] });
    expect([...(await readHeadPlanDigests(api, "ship")).entries()].map(([h, m]) => [h, [...m]])).toEqual([["aaa", [[1, "sha256:one"]]]]);
    expect([...(await readAllHeadPlans(web, "ship")).keys()]).toEqual(["bbb"]);
    expect(await listWavePlanSpecs(api)).toEqual(["ship"]);
    expect(await listReleaseEnvironmentsOn(api)).toEqual(["prod", "staging"]);
    expect(await listWavePlanSpecs(gitLedgerReadPort({ cwd, member: "." }))).toEqual([]);
  });
});
