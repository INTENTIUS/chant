/**
 * #4293: `chant lock` and `chant unlock` take, list and release target locks
 * on `chant/lifecycle`, and exit 3 when another pull request holds a target.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { commandRegistry, parseArgs } from "../main";
import { resolveCommand } from "../registry";

const dirs: string[] = [];
const home = process.cwd();
afterAll(() => {
  process.chdir(home);
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function initRepo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "chant-lock-cli-")));
  dirs.push(dir);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "test@chant.dev");
  git(dir, "config", "user.name", "Test");
  git(dir, "config", "commit.gpgsign", "false");
  writeFileSync(join(dir, "README.md"), "# t\n");
  git(dir, "add", "README.md");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

async function run(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  vi.spyOn(console, "log").mockImplementation((s) => void (out += String(s) + "\n"));
  vi.spyOn(console, "error").mockImplementation((s) => void (err += String(s) + "\n"));
  const args = parseArgs(argv);
  const match = resolveCommand(args, commandRegistry);
  expect(match?.def.name).toBe(argv[0]);
  const code = await match!.def.handler({ args, plugins: [], serializers: [] });
  vi.restoreAllMocks();
  return { code: code ?? 0, out, err };
}

let repo: string;
beforeEach(() => {
  repo = initRepo();
  process.chdir(repo);
});
afterEach(() => {
  process.chdir(home);
  vi.restoreAllMocks();
});

describe("chant lock and chant unlock", () => {
  test("lock takes named targets, a second pull request exits 5 naming the holder, unlock frees them", async () => {
    const taken = await run(["lock", "web", "api", "--pr", "1", "--by", "alice", "--json"]);
    expect(taken.code).toBe(0);
    expect(JSON.parse(taken.out)).toMatchObject({ gate: "pr-apply", pr: 1, ok: true, stage: "lock", taken: ["api", "web"] });

    const held = await run(["lock", "web", "--pr", "2", "--by", "bob"]);
    expect(held.code).toBe(5);
    expect(held.err).toContain("web is locked by pull request 1 (locked with chant lock by alice), so pull request 2 is not locked");

    const listed = await run(["lock", "--list", "--json"]);
    expect(Object.keys(JSON.parse(listed.out).locks)).toEqual(["api", "web"]);

    const released = await run(["unlock", "--pr", "1", "--json"]);
    expect(JSON.parse(released.out)).toMatchObject({ released: ["api", "web"] });
    expect((await run(["lock", "web", "--pr", "2", "--by", "bob"])).code).toBe(0);
  });

  test("--from-report locks the components a pr-plan.json selected, as plan locks, and refuses another pull request's report", async () => {
    const report = join(repo, "pr-plan.json");
    writeFileSync(report, JSON.stringify({ pr: 4, head: "b".repeat(40), selection: { waves: [["db"], ["api", "web"]] } }));
    const taken = await run(["lock", "--from-report", report, "--pr", "4", "--stage", "plan", "--json"]);
    expect(JSON.parse(taken.out)).toMatchObject({ ok: true, stage: "plan", taken: ["api", "db", "web"] });
    const file = JSON.parse(git(repo, "show", "chant/lifecycle:_locks/pr-apply.json"));
    expect(file.locks.db).toMatchObject({ pr: 4, stage: "plan", head: "b".repeat(40) });

    const wrong = await run(["lock", "--from-report", report, "--pr", "5"]);
    expect(wrong.code).toBe(1);
    expect(wrong.err).toContain("is the report of pull request 4, not 5");
  });

  test("--list shows the apply rows of the gate with the run that holds each (#4594)", async () => {
    const { takeLockRows } = await import("../../lifecycle/resource-lock");
    const holder = { run: "4711", at: "2026-10-27T10:00:00.000Z", url: "https://forge.example/acme/infra/actions/runs/4711" };
    const rows = [
      { key: "urn urn:pulumi:dev::site::aws:s3/bucket:Bucket::logs", target: "site", address: "logs" },
      { key: "estate e01 aws_s3_bucket.logs", target: "e01", address: "aws_s3_bucket.logs" },
    ];
    expect(await takeLockRows("pr-apply", rows, holder, { cwd: repo, alive: async () => "alive" })).toMatchObject({ ok: true });

    const text = await run(["lock", "--list"]);
    expect(text.code).toBe(0);
    expect(text.out).toContain("estate e01 aws_s3_bucket.logs\trun 4711\t2026-10-27T10:00:00.000Z\thttps://forge.example/acme/infra/actions/runs/4711");
    expect(text.out).toContain("urn urn:pulumi:dev::site::aws:s3/bucket:Bucket::logs\trun 4711");
    expect(text.err).toContain("no target locks on pr-apply");

    const json = JSON.parse((await run(["lock", "--list", "--json"])).out);
    expect(json.rowsPath).toBe("_locks/rows/pr-apply.json");
    expect(Object.keys(json.rows)).toEqual(["estate e01 aws_s3_bucket.logs", "urn urn:pulumi:dev::site::aws:s3/bucket:Bucket::logs"]);
    expect(json.rows["estate e01 aws_s3_bucket.logs"]).toEqual(holder);
  });

  test("--list says no apply rows are held when the rows file is empty (#4594)", async () => {
    const listed = await run(["lock", "--list", "--json"]);
    expect(JSON.parse(listed.out)).toMatchObject({ gate: "pr-apply", rows: {} });
    expect((await run(["lock", "--list"])).err).toContain("no apply rows held on pr-apply");
  });

  test("refuses without --pr or targets, an unknown stage, and a gate that is not a file name", async () => {
    expect((await run(["lock", "web"])).err).toContain("--pr <n>");
    expect((await run(["lock", "--pr", "1"])).err).toContain("needs the targets");
    expect((await run(["lock", "web", "--pr", "1", "--stage", "merge"])).err).toContain("--stage merge is not one of plan, apply, lock");
    expect((await run(["lock", "web", "--pr", "1", "--gate", "../x"])).code).toBe(1);
    expect((await run(["unlock"])).err).toContain("--pr <n>");
  });
});
