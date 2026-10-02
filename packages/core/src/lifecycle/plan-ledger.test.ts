import { describe, test, expect } from "vitest";
import { withTestDir } from "@intentius/chant-test-utils";
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { persistReleasePlan, readReleasePlan, InvalidReleasePlanError, type ReleasePlan } from "./plan-ledger";
import { readRefSha } from "./git";

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

function makePlan(digest: string, extra: Record<string, unknown> = {}): ReleasePlan {
  return { digest, release: "r-abc12345", units: [{ id: "w-1", contract: "c-1" }], evidence: [], ...extra };
}

describe("lifecycle/plan-ledger", () => {
  describe("persistReleasePlan / readReleasePlan", () => {
    test("round-trips a plan by its own digest", async () => {
      await withTestDir(async (dir) => {
        await initRepo(dir);
        const plan = makePlan("sha256:" + "1".repeat(64));

        const { commit, written } = await persistReleasePlan(plan, { cwd: dir });
        expect(written).toBe(true);
        expect(commit).toMatch(/^[0-9a-f]{40}$/);

        const readBack = await readReleasePlan(plan.digest, { cwd: dir });
        expect(readBack).toEqual(plan);
      });
    });

    test("readReleasePlan returns null for an unknown digest", async () => {
      await withTestDir(async (dir) => {
        await initRepo(dir);
        expect(await readReleasePlan("sha256:doesnotexist", { cwd: dir })).toBeNull();
      });
    });

    test("a plan already written is never rewritten: no second commit, content unchanged", async () => {
      await withTestDir(async (dir) => {
        await initRepo(dir);
        const plan = makePlan("sha256:" + "2".repeat(64));

        const first = await persistReleasePlan(plan, { cwd: dir });
        expect(first.written).toBe(true);
        const tipAfterFirst = await readRefSha("refs/heads/chant/lifecycle", { cwd: dir });

        const second = await persistReleasePlan(plan, { cwd: dir });
        expect(second.written).toBe(false);
        expect(second.commit).toBeNull();
        const tipAfterSecond = await readRefSha("refs/heads/chant/lifecycle", { cwd: dir });

        // Not a new commit — the branch tip is unchanged.
        expect(tipAfterSecond).toBe(tipAfterFirst);
        expect(await readReleasePlan(plan.digest, { cwd: dir })).toEqual(plan);
      });
    });

    test("a plan with a different digest is a separate entry, coexisting with the first", async () => {
      await withTestDir(async (dir) => {
        await initRepo(dir);
        const planA = makePlan("sha256:" + "a".repeat(64), { release: "r-a" });
        const planB = makePlan("sha256:" + "b".repeat(64), { release: "r-b" });

        await persistReleasePlan(planA, { cwd: dir });
        await persistReleasePlan(planB, { cwd: dir });

        expect(await readReleasePlan(planA.digest, { cwd: dir })).toEqual(planA);
        expect(await readReleasePlan(planB.digest, { cwd: dir })).toEqual(planB);
      });
    });

    test("refuses a plan with no digest field", async () => {
      await withTestDir(async (dir) => {
        await initRepo(dir);
        const plan = { release: "r-nodigest" } as unknown as ReleasePlan;
        await expect(persistReleasePlan(plan, { cwd: dir })).rejects.toThrow(InvalidReleasePlanError);
      });
    });

    test("release ledger and plan store coexist on the same orphan branch", async () => {
      const { appendReleaseRecord, readReleaseLedger } = await import("./release-ledger");
      await withTestDir(async (dir) => {
        await initRepo(dir);
        const plan = makePlan("sha256:" + "3".repeat(64));
        await persistReleasePlan(plan, { cwd: dir });
        await appendReleaseRecord(
          {
            component: "svc",
            env: "prod",
            digest: plan.digest,
            gitSha: "deadbeef",
            runId: "run-1",
            timestamp: "2026-01-01T00:00:00.000Z",
            actor: "ci-bot",
          },
          { cwd: dir },
        );

        expect(await readReleasePlan(plan.digest, { cwd: dir })).toEqual(plan);
        const { records } = await readReleaseLedger("prod", { cwd: dir });
        expect(records).toHaveLength(1);
        expect(records[0].digest).toBe(plan.digest);
      });
    });

    test("a member's plan lives under _members/<member>/_plans/ (#2524 D7), reached via the prefix readReleasePlan takes", async () => {
      await withTestDir(async (dir) => {
        await initRepo(dir);
        mkdirSync(join(dir, "apps", "web"), { recursive: true });
        writeFileSync(join(dir, "chant.workspace.json"), JSON.stringify({
          name: "acme",
          schema: 1,
          members: [{ name: "web", dir: "apps/web", kind: "chant" }],
        }));
        writeFileSync(join(dir, "apps", "web", "chant.config.ts"), "");
        git(["add", "-A"], dir);
        git(["commit", "-q", "-m", "workspace"], dir);

        const plan = makePlan("sha256:" + "4".repeat(64));
        // Persisted from inside the member's own directory, the way `chant
        // components release` runs there — writeBlobToPath resolves the
        // _members/web/ prefix automatically from cwd.
        const webDir = join(dir, "apps", "web");
        await persistReleasePlan(plan, { cwd: webDir });

        // readReleasePlan reads it back two ways: with the matching prefix
        // (as ../workspace/status.ts resolves it for a "members"-layout
        // release), and directly at the branch path it actually landed on.
        expect(await readReleasePlan(plan.digest, { cwd: dir, prefix: "_members/web/" })).toEqual(plan);
        const raw = git(["show", `chant/lifecycle:_members/web/_plans/sha256_${"4".repeat(64)}.json`], dir);
        expect(raw.exitCode).toBe(0);
        expect(JSON.parse(raw.stdout)).toEqual(plan);
      });
    });
  });
});
