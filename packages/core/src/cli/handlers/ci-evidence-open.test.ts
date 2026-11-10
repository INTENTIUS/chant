/**
 * #4914: `chant ci evidence sign --open`, the GitLab signing job of the
 * target branch's plan notes pipeline. For each open merge request it reads
 * the newest plan or check job's report from its artifact, signs it for the
 * head, keeps `<out>/<iid>/evidence.json` naming the head, and does not
 * sign a head again once its evidence is current. The forge is a fake; the
 * repository, the runner key and the notes are real.
 */

import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { loadRunnerKey } from "../../workspace/trust/dsse";
import { readCheckEvidence } from "../../workspace/trust/check-evidence";
import { signOpenReports } from "../../workspace/trust/open-evidence";
import { parseArgs } from "../parse-args";
import type { CommandContext } from "../registry";
import type { MergeRequestJob, PrForge } from "../../pr-forge";

const forge = vi.hoisted(() => ({ current: undefined as unknown }));
vi.mock("../../pr-forge", async (actual) => ({ ...(await actual<typeof import("../../pr-forge")>()), forgeFromEnv: () => forge.current }));

const { runCiEvidence } = await import("./ci-evidence");

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "init.defaultBranch=main", ...args], { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** A repository whose base lists `ci`'s key as a runner, and a merge request's head on a branch beside it. */
function repo(): { dir: string; base: string; head: string; pem: string } {
  const dir = mkdtempSync(join(tmpdir(), "chant-4914-"));
  const { privateKey } = generateKeyPairSync("ed25519");
  const pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  git(dir, "init", "--quiet");
  mkdirSync(join(dir, ".chant"));
  writeFileSync(join(dir, ".chant/trust.json"), JSON.stringify({ schema: 1, runners: [{ principal: "ci", class: "runner", key: loadRunnerKey(pem).publicKey }] }));
  writeFileSync(join(dir, "main.tf"), "# base\n");
  git(dir, "add", ".");
  git(dir, "commit", "--quiet", "-m", "base");
  const base = git(dir, "rev-parse", "HEAD");
  git(dir, "checkout", "--quiet", "-b", "change");
  writeFileSync(join(dir, "main.tf"), "# change\n");
  git(dir, "commit", "--quiet", "-am", "change");
  const head = git(dir, "rev-parse", "HEAD");
  git(dir, "checkout", "--quiet", "main");
  return { dir, base, head, pem };
}

/** A GitLab client with the merge requests' jobs and each job's artifact files. */
function gitlab(jobs: MergeRequestJob[], artifacts: Record<number, Record<string, string>>) {
  const asked: string[] = [];
  const client = {
    kind: "gitlab",
    async mergeRequestJobs(_branch: string, job: string) {
      asked.push(job);
      return jobs;
    },
    async jobArtifact(id: number, path: string) {
      return artifacts[id]?.[path];
    },
  } as unknown as PrForge;
  return { client, asked };
}

const PLAN = JSON.stringify({ version: 1, policy: { result: "passed" } });
const CHECK = JSON.stringify({ version: 1, hooks: [{ name: "lint", exit: 0, outcome: "passed" }, { name: "tests", exit: 1, outcome: "failed" }] });

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.CHANT_RUNNER_KEY;
});

async function run(dir: string, argv: string[]): Promise<number> {
  vi.spyOn(process, "cwd").mockReturnValue(dir);
  vi.spyOn(console, "error").mockImplementation(() => {});
  return runCiEvidence({ args: parseArgs(["ci", "evidence", "sign", ...argv]) } as CommandContext);
}

describe("ci evidence sign --open (#4914)", () => {
  test("signs each open merge request's settled plan job for its head, keeps evidence.json naming it, and signs a head once", async () => {
    const r = repo();
    const g = gitlab(
      [
        { pr: 7, head: r.head, id: 101, status: "success" },
        { pr: 8, head: r.head, id: 102, status: "running" },
      ],
      { 101: { ".chant/pr/pr-plan.json": PLAN } },
    );
    forge.current = g.client;
    process.env.CHANT_RUNNER_KEY = r.pem;
    const out = join(r.dir, ".chant/evidence/plan");
    const argv = ["--open", "--job", "plan", "--from-report", ".chant/pr", "--base", r.base, "--branch", "main", "-o", out, "--no-push"];
    expect(await run(r.dir, argv)).toBe(0);
    expect(g.asked).toEqual(["plan"]);
    const kept = JSON.parse(readFileSync(join(out, "7", "evidence.json"), "utf-8"));
    expect(kept).toMatchObject({ pr: 7, head: r.head, skipped: [] });
    expect(kept.signed.map((s: { check: string }) => s.check)).toEqual(["plan", "policy"]);
    expect(existsSync(join(out, "8"))).toBe(false);
    expect((await readCheckEvidence(r.dir, r.head, r.base, ["plan", "policy"])).map((v) => v.status)).toEqual(["current", "current"]);
    // The next scheduled pipeline: the head's evidence is current, so nothing is signed again, and the file says it is signed.
    const notes = git(r.dir, "notes", "--ref=refs/notes/chant/evidence", "list");
    expect(await run(r.dir, argv)).toBe(0);
    expect(git(r.dir, "notes", "--ref=refs/notes/chant/evidence", "list")).toBe(notes);
    expect(JSON.parse(readFileSync(join(out, "7", "evidence.json"), "utf-8")).signed.map((s: { check: string; runner: string }) => `${s.check}:${s.runner}`)).toEqual(["plan:ci", "policy:ci"]);
  });

  test("signs each hook that passed from a check job's artifact, and none of a fork's with --no-forks", async () => {
    const r = repo();
    const g = gitlab(
      [
        { pr: 7, head: r.head, id: 201, status: "failed" },
        { pr: 9, head: r.head, id: 202, status: "success", fork: true },
      ],
      { 201: { ".chant/check/check-hooks.json": CHECK }, 202: { ".chant/check/check-hooks.json": CHECK } },
    );
    forge.current = g.client;
    process.env.CHANT_RUNNER_KEY = r.pem;
    const out = join(r.dir, ".chant/evidence/check");
    expect(await run(r.dir, ["--open", "--job", "check", "--from-report", ".chant/check", "--base", r.base, "--branch", "main", "-o", out, "--no-push", "--no-forks"])).toBe(0);
    const kept = JSON.parse(readFileSync(join(out, "7", "evidence.json"), "utf-8"));
    expect(kept.signed.map((s: { check: string }) => s.check)).toEqual(["lint"]);
    expect(kept.skipped).toEqual([{ check: "tests", reason: "the hook did not pass in the check job" }]);
    expect(existsSync(join(out, "9"))).toBe(false);
  });

  test("refuses what it cannot sign for: no job, no output, a fixed head", async () => {
    const r = repo();
    forge.current = gitlab([], {}).client;
    expect(await run(r.dir, ["--open", "--from-report", ".chant/pr", "-o", "x", "--branch", "main"])).toBe(1);
    expect(await run(r.dir, ["--open", "--job", "plan", "--from-report", ".chant/pr", "--branch", "main"])).toBe(1);
    expect(await run(r.dir, ["--open", "--job", "plan", "--from-report", ".chant/pr", "-o", "x", "--branch", "main", "--at", "HEAD"])).toBe(1);
  });
});

describe("signOpenReports (#4914)", () => {
  test("a job that left no report, or whose head does not fetch, is said and signs nothing", async () => {
    const out = mkdtempSync(join(tmpdir(), "chant-4914-open-"));
    const g = gitlab(
      [
        { pr: 1, head: "a".repeat(40), id: 1, status: "success" },
        { pr: 2, head: "b".repeat(40), id: 2, status: "success" },
      ],
      { 2: { ".chant/pr/pr-plan.json": PLAN } },
    );
    const sign = vi.fn();
    const { done } = await signOpenReports({ forge: g.client, branch: "main", job: "plan", artifactDir: ".chant/pr/", out, fetchHead: () => false, sign });
    expect(done.map((d) => [d.pr, d.skipped])).toEqual([
      [1, "the plan job left no report under .chant/pr"],
      [2, `the head ${"b".repeat(12)} did not fetch`],
    ]);
    expect(sign).not.toHaveBeenCalled();
  });

  test("a forge that cannot list merge request jobs is refused", async () => {
    await expect(signOpenReports({ forge: { kind: "github" } as PrForge, branch: "main", job: "plan", artifactDir: ".chant/pr", out: "x", fetchHead: () => true, sign: vi.fn() })).rejects.toThrow(/it is for GitLab/);
  });
});
