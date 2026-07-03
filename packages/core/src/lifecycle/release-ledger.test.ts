import { describe, test, expect } from "vitest";
import { withTestDir } from "@intentius/chant-test-utils";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  appendReleaseRecord,
  readReleaseLedger,
  listReleaseEnvironments,
  validateReleaseRecord,
  InvalidReleaseRecordError,
  latestPerComponent,
  recordsForDigest,
  type ReleaseRecord,
  type ReleaseRecordInput,
} from "./release-ledger";

function git(args: string[], cwd: string): { stdout: string; exitCode: number } {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
  return { stdout: r.stdout ?? "", exitCode: r.status ?? -1 };
}

async function initRepo(dir: string): Promise<void> {
  git(["init", "-q", "-b", "main"], dir);
  git(["config", "user.email", "test@chant.dev"], dir);
  git(["config", "user.name", "Test"], dir);
  writeFileSync(join(dir, "README.md"), "fixture\n");
  git(["add", "README.md"], dir);
  git(["commit", "-q", "-m", "init"], dir);
}

function makeInput(overrides?: Partial<ReleaseRecordInput>): ReleaseRecordInput {
  return {
    component: "search-service",
    env: "prod",
    digest: "sha256:abc123",
    gitSha: "deadbeef",
    runId: "run-1",
    timestamp: "2026-01-01T00:00:00.000Z",
    actor: "ci-bot",
    ...overrides,
  };
}

describe("release-ledger", () => {
  describe("validateReleaseRecord", () => {
    test("no missing fields for a complete record", () => {
      expect(validateReleaseRecord({ version: 1, ...makeInput() })).toEqual([]);
    });

    test("reports every missing required field", () => {
      const missing = validateReleaseRecord({ component: "x" });
      expect(missing).toContain("env");
      expect(missing).toContain("digest");
      expect(missing).toContain("gitSha");
      expect(missing).toContain("runId");
      expect(missing).toContain("timestamp");
      expect(missing).toContain("actor");
      expect(missing).not.toContain("component");
    });

    test("empty string counts as missing", () => {
      expect(validateReleaseRecord({ ...makeInput(), actor: "" })).toEqual(["actor"]);
    });
  });

  describe("appendReleaseRecord", () => {
    test("throws InvalidReleaseRecordError before any git operation on an incomplete record", async () => {
      await withTestDir(async (dir) => {
        await initRepo(dir);
        await expect(
          appendReleaseRecord({ ...makeInput(), actor: "" }, { cwd: dir }),
        ).rejects.toBeInstanceOf(InvalidReleaseRecordError);
        const ledger = await readReleaseLedger("prod", { cwd: dir });
        expect(ledger.records).toEqual([]);
      });
    });

    test("writes one JSON-lines record readable back via readReleaseLedger", async () => {
      await withTestDir(async (dir) => {
        await initRepo(dir);
        const { commit, record } = await appendReleaseRecord(makeInput(), { cwd: dir });
        expect(commit).toMatch(/^[0-9a-f]{40}$/);
        expect(record.version).toBe(1);

        const { records, malformed } = await readReleaseLedger("prod", { cwd: dir });
        expect(malformed).toBe(0);
        expect(records).toHaveLength(1);
        expect(records[0]).toMatchObject(makeInput());
      });
    });

    test("appends rather than replaces — multiple releases accumulate in order", async () => {
      await withTestDir(async (dir) => {
        await initRepo(dir);
        await appendReleaseRecord(makeInput({ digest: "sha256:v1", timestamp: "2026-01-01T00:00:00.000Z" }), { cwd: dir });
        await appendReleaseRecord(makeInput({ digest: "sha256:v2", timestamp: "2026-01-02T00:00:00.000Z" }), { cwd: dir });
        await appendReleaseRecord(makeInput({ digest: "sha256:v3", timestamp: "2026-01-03T00:00:00.000Z" }), { cwd: dir });

        const { records } = await readReleaseLedger("prod", { cwd: dir });
        expect(records.map((r) => r.digest)).toEqual(["sha256:v1", "sha256:v2", "sha256:v3"]);
      });
    });

    test("never mutates a previously written record — old lines survive new appends byte-identical", async () => {
      await withTestDir(async (dir) => {
        await initRepo(dir);
        await appendReleaseRecord(makeInput({ digest: "sha256:v1" }), { cwd: dir });
        const { records: afterFirst } = await readReleaseLedger("prod", { cwd: dir });

        await appendReleaseRecord(makeInput({ digest: "sha256:v2", component: "other-service" }), { cwd: dir });
        const { records: afterSecond } = await readReleaseLedger("prod", { cwd: dir });

        expect(afterSecond[0]).toEqual(afterFirst[0]);
        expect(afterSecond).toHaveLength(2);
      });
    });

    test("separate environments get separate ledgers", async () => {
      await withTestDir(async (dir) => {
        await initRepo(dir);
        await appendReleaseRecord(makeInput({ env: "staging", digest: "sha256:staging1" }), { cwd: dir });
        await appendReleaseRecord(makeInput({ env: "prod", digest: "sha256:prod1" }), { cwd: dir });

        const staging = await readReleaseLedger("staging", { cwd: dir });
        const prod = await readReleaseLedger("prod", { cwd: dir });
        expect(staging.records.map((r) => r.digest)).toEqual(["sha256:staging1"]);
        expect(prod.records.map((r) => r.digest)).toEqual(["sha256:prod1"]);
      });
    });

    test("release ledger and snapshot coexist on the same orphan branch without clobbering each other", async () => {
      const { writeSnapshot, readSnapshot } = await import("./git");
      await withTestDir(async (dir) => {
        await initRepo(dir);
        await writeSnapshot("prod", "aws", JSON.stringify({ a: 1 }), { cwd: dir });
        await appendReleaseRecord(makeInput({ env: "prod" }), { cwd: dir });

        expect(await readSnapshot("prod", "aws", { cwd: dir })).toBeTruthy();
        const { records } = await readReleaseLedger("prod", { cwd: dir });
        expect(records).toHaveLength(1);
      });
    });
  });

  describe("readReleaseLedger", () => {
    test("returns empty for an environment with no ledger", async () => {
      await withTestDir(async (dir) => {
        await initRepo(dir);
        const { records, malformed } = await readReleaseLedger("prod", { cwd: dir });
        expect(records).toEqual([]);
        expect(malformed).toBe(0);
      });
    });
  });

  describe("listReleaseEnvironments", () => {
    test("lists every environment carrying a release ledger", async () => {
      await withTestDir(async (dir) => {
        await initRepo(dir);
        await appendReleaseRecord(makeInput({ env: "prod" }), { cwd: dir });
        await appendReleaseRecord(makeInput({ env: "staging" }), { cwd: dir });
        expect(await listReleaseEnvironments({ cwd: dir })).toEqual(["prod", "staging"]);
      });
    });

    test("returns empty when no orphan branch exists yet", async () => {
      await withTestDir(async (dir) => {
        await initRepo(dir);
        expect(await listReleaseEnvironments({ cwd: dir })).toEqual([]);
      });
    });
  });

  describe("latestPerComponent", () => {
    test("picks the record with the latest timestamp per component", () => {
      const records: ReleaseRecord[] = [
        { version: 1, ...makeInput({ digest: "sha256:v1", timestamp: "2026-01-01T00:00:00.000Z" }) },
        { version: 1, ...makeInput({ digest: "sha256:v2", timestamp: "2026-01-03T00:00:00.000Z" }) },
        { version: 1, ...makeInput({ digest: "sha256:v1-mid", timestamp: "2026-01-02T00:00:00.000Z" }) },
      ];
      const latest = latestPerComponent(records);
      expect(latest.get("search-service")?.digest).toBe("sha256:v2");
    });

    test("keeps separate entries per component", () => {
      const records: ReleaseRecord[] = [
        { version: 1, ...makeInput({ component: "a", digest: "sha256:a1" }) },
        { version: 1, ...makeInput({ component: "b", digest: "sha256:b1" }) },
      ];
      const latest = latestPerComponent(records);
      expect(latest.get("a")?.digest).toBe("sha256:a1");
      expect(latest.get("b")?.digest).toBe("sha256:b1");
    });
  });

  describe("recordsForDigest", () => {
    test("finds every record referencing a given digest", () => {
      const records: ReleaseRecord[] = [
        { version: 1, ...makeInput({ env: "staging", digest: "sha256:shared" }) },
        { version: 1, ...makeInput({ env: "prod", digest: "sha256:shared" }) },
        { version: 1, ...makeInput({ env: "prod", digest: "sha256:other" }) },
      ];
      const found = recordsForDigest(records, "sha256:shared");
      expect(found).toHaveLength(2);
      expect(found.every((r) => r.digest === "sha256:shared")).toBe(true);
    });
  });
});
