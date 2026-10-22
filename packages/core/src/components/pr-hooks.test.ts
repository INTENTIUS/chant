/**
 * `ci.hooks` on the pull-request path (#4288): read from the declaration at
 * base, the top level's then the member's, and run with targets.
 */
import { afterAll, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseDeclaration, WorkspaceReadError } from "../workspace/declaration";
import { prLoopHooksAt, prLoopHooksOf, runPrHooks } from "./pr-hooks";
import type { OpWaveExec } from "../op/op-waves-run";

const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});
const tmp = (): string => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "pr-hooks-")));
  scratch.push(d);
  return d;
};
const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();

const declaration = (hooks: unknown, memberHooks?: unknown) => ({
  name: "acme",
  schema: 1,
  members: [{ name: "infra", dir: "infra", kind: "other", because: "test", ...(memberHooks ? { ci: { hooks: memberHooks } } : {}) }],
  ...(hooks ? { ci: { hooks } } : {}),
});

describe("ci.hooks in the declaration (#4288)", () => {
  test("parses at the top level and on a member; the member's run after the top level's", () => {
    const d = parseDeclaration(
      JSON.stringify(declaration({ before: { observe: [{ name: "init", command: ["init"] }] } }, { before: { observe: [{ name: "member-init", command: ["mi"], targets: ["db*"] }] } })),
      "chant.workspace.json",
      "0.124.41",
    );
    expect(d.ci?.hooks).toEqual({ before: { observe: [{ name: "init", command: ["init"] }] } });
    expect(prLoopHooksOf(d, "infra")["before-observe"]!.map((h) => h.name)).toEqual(["init", "member-init"]);
    expect(prLoopHooksOf(d, null)["before-observe"]!.map((h) => h.name)).toEqual(["init"]);
  });

  test("refuses hooks a pull-request job cannot run", () => {
    const read = (hooks: unknown) => () => parseDeclaration(JSON.stringify(declaration(hooks)), "chant.workspace.json", "0.124.41");
    expect(read({ after: { gate: [{ command: ["x"] }] } })).toThrow(WorkspaceReadError);
    expect(read({ before: { plan: [{ command: [] }] } })).toThrow(/must be a command as argv/);
    expect(read({ apply: { runBy: "apply" } })).toThrow(/runBy is for an Op waves spec/);
  });
});

describe("prLoopHooksAt (#4288)", () => {
  test("reads the hooks at base: a change cannot add, edit or remove one its own job runs", () => {
    const repo = tmp();
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.email", "t@example.com");
    git(repo, "config", "user.name", "t");
    mkdirSync(join(repo, "infra"));
    writeFileSync(join(repo, "chant.workspace.json"), JSON.stringify(declaration({ before: { plan: [{ name: "lint", command: ["lint"] }] } })));
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "base");
    const base = git(repo, "rev-parse", "HEAD");
    writeFileSync(join(repo, "chant.workspace.json"), JSON.stringify(declaration({ before: { plan: [{ name: "sneaky", command: ["curl"] }] } })));
    const read = prLoopHooksAt(join(repo, "infra"), base);
    expect(read.hooks["before-plan"]!.map((h) => h.name)).toEqual(["lint"]);
    expect(read.base).toBe(base);
  });

  test("a base with no declaration runs no hook, and says so when the change declares some", () => {
    const repo = tmp();
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.email", "t@example.com");
    git(repo, "config", "user.name", "t");
    writeFileSync(join(repo, "README"), "x");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "base");
    const base = git(repo, "rev-parse", "HEAD");
    expect(prLoopHooksAt(repo, base)).toEqual({ hooks: {}, base });
    writeFileSync(join(repo, "chant.workspace.json"), JSON.stringify(declaration({ before: { plan: [{ command: ["lint"] }] } })));
    const read = prLoopHooksAt(repo, base);
    expect(read.hooks).toEqual({});
    expect(read.note).toMatch(/has no workspace declaration, so the hooks this change declares do not run until it merges/);
  });
});

describe("runPrHooks (#4288)", () => {
  test("runs a moment for the selected components, writes the runs and plan files, and reports a failure", () => {
    const cwd = tmp();
    const calls: Array<{ argv: string; env?: Record<string, string> }> = [];
    const exec: OpWaveExec = (argv, _dir, env) => {
      calls.push({ argv: argv.join(" "), ...(env ? { env } : {}) });
      return argv[1] === "web" ? 1 : 0;
    };
    const read = {
      base: "b".repeat(40),
      hooks: { "after-plan": [{ name: "check", command: ["check", "{target}", "{plan}"], perRun: true, targets: ["api", "web"] }] },
    };
    const ran = runPrHooks(read, "after-plan", { op: "pr-7", env: "prod", stage: "plan", dir: ".chant/pr", cwd, exec, log: () => {} }, ["api", "db", "web"], {
      members: [{ member: "api", component: "api", planDigest: "sha256:1", status: "planned", counts: { create: 1, update: 0, replace: 0, delete: 0 } }],
      plans: { api: { api: { file: "plan.bin" } } },
    });
    expect(calls.map((c) => c.argv)).toEqual(["check api .chant/pr/hooks/plans/api.json", "check web .chant/pr/hooks/plans/web.json"]);
    expect(calls[0]!.env).toMatchObject({ CHANT_HOOK: "after-plan", CHANT_TARGET: "api", CHANT_ENV: "prod", CHANT_PR_STAGE: "plan", CHANT_HOOKS_BASE: "b".repeat(40) });
    expect(JSON.parse(readFileSync(join(cwd, ".chant/pr/hooks/plans/api.json"), "utf-8"))).toMatchObject({ component: "api", plans: { api: { file: "plan.bin" } } });
    expect(JSON.parse(readFileSync(join(cwd, ".chant/pr/hooks/runs.json"), "utf-8")).runs.map((r: { target: string }) => r.target)).toEqual(["api", "db", "web"]);
    expect(ran.outcomes).toEqual([
      { moment: "after-plan", name: "check", target: "api", exit: 0, outcome: "passed" },
      { moment: "after-plan", name: "check", target: "web", exit: 1, outcome: "failed" },
    ]);
    expect(ran.failed).toBe("after-plan hook check (web) exited 1");
  });

  test("a moment with no hooks runs nothing and writes nothing", () => {
    const cwd = tmp();
    const ran = runPrHooks({ base: "b", hooks: {} }, "before-apply", { op: "pr-7", env: "prod", stage: "apply", dir: ".chant/pr", cwd, log: () => {} }, ["api"]);
    expect(ran).toEqual({ outcomes: [], holds: [] });
  });
});
