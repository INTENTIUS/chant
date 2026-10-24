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
import { PR_LOOP_HOOK_MOMENTS } from "../op/op-waves";
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
  test("accepts after.gate, and runs it after the plan-side moments (#4323)", () => {
    const d = parseDeclaration(JSON.stringify(declaration({ after: { gate: [{ name: "report", command: ["report"] }] } }, { after: { gate: [{ name: "member-report", command: ["mr"] }] } })), "chant.workspace.json", "0.124.41");
    expect(prLoopHooksOf(d, "infra")["after-gate"]!.map((h) => h.name)).toEqual(["report", "member-report"]);
    expect(PR_LOOP_HOOK_MOMENTS).toContain("after-gate");
  });

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
    expect(read({ before: { plan: [{ command: ["x"], onFailure: "bogus" }] } })).toThrow(WorkspaceReadError);
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
  test("runs a moment for the selected components, writes the runs and plan files, and reports a failure", async () => {
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
    const ran = await runPrHooks(read, "after-plan", { op: "pr-7", env: "prod", stage: "plan", dir: ".chant/pr", cwd, exec, log: () => {} }, ["api", "db", "web"], {
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

  test("a moment with no hooks runs nothing and writes nothing", async () => {
    const cwd = tmp();
    const ran = await runPrHooks({ base: "b", hooks: {} }, "before-apply", { op: "pr-7", env: "prod", stage: "apply", dir: ".chant/pr", cwd, log: () => {} }, ["api"]);
    expect(ran).toEqual({ outcomes: [], holds: [] });
  });

  const holdBody = { gate: "db-migrate", digest: "sha256:m1", op: "other-op" };
  /** An exec for a hook that holds on db-migrate until CHANT_HOLD_APPROVED is set. */
  const holdingExec = (cwd: string, calls: Array<Record<string, string> | undefined>): OpWaveExec => (argv, _dir, env) => {
    calls.push(env);
    if (env?.CHANT_HOLD_APPROVED) return 0;
    writeFileSync(join(cwd, env!.CHANT_HOLD!), JSON.stringify(holdBody));
    return argv[0] === "hold" ? 1 : 0;
  };
  const gateHooks = { "after-gate": [{ name: "migrate", command: ["hold"], onFailure: "approve" as const }] };
  const place = (cwd: string, exec: OpWaveExec) => ({ op: "pr-7", env: "prod", stage: "apply" as const, dir: ".chant/pr", cwd, exec, log: () => {} });

  test("an after-gate hook gets the gate's decision in its environment (#4323)", async () => {
    const cwd = tmp();
    const calls: Array<Record<string, string> | undefined> = [];
    const exec: OpWaveExec = (_argv, _dir, env) => (calls.push(env), 0);
    const read = { base: "b", hooks: { "after-gate": [{ name: "report", command: ["report"] }] } };
    const decision = { CHANT_GATE_STATUS: "approved", CHANT_GATE_OP: "pr-7", CHANT_GATE: "pr-apply", CHANT_GATE_DIGEST: "sha256:p" };
    const ran = await runPrHooks(read, "after-gate", place(cwd, exec), ["api"], undefined, { env: decision });
    expect(calls[0]).toMatchObject({ CHANT_HOOK: "after-gate", ...decision });
    expect(ran.outcomes).toEqual([{ moment: "after-gate", name: "report", exit: 0, outcome: "passed" }]);
  });

  test("a hold on another gate clears once that gate is approved: the hook runs again with CHANT_HOLD_APPROVED (#4323)", async () => {
    const cwd = tmp();
    const calls: Array<Record<string, string> | undefined> = [];
    let approved = false;
    const asked: string[] = [];
    const settle = async (hold: { request: { gate: string; digest: string; op?: string } }) => {
      asked.push(`${hold.request.op} / ${hold.request.gate} @ ${hold.request.digest}`);
      return approved ? { status: "approved" as const, approvedBy: "alice", approvedAt: "2026-10-23T00:00:00Z" } : { status: "waiting" as const };
    };
    const read = { base: "b", hooks: gateHooks };
    const first = await runPrHooks(read, "after-gate", place(cwd, holdingExec(cwd, calls)), ["api"], undefined, { settle });
    expect(first.failed).toMatch(/^after-gate hook migrate waits on other-op \/ db-migrate, which nobody approved at sha256:m1\. Approve: /);
    expect(first.holds).toEqual([]);

    approved = true;
    calls.length = 0;
    const second = await runPrHooks(read, "after-gate", place(cwd, holdingExec(cwd, calls)), ["api"], undefined, { settle });
    expect(second.failed).toBeUndefined();
    expect(second.holds).toEqual([]);
    expect(asked).toEqual(["other-op / db-migrate @ sha256:m1", "other-op / db-migrate @ sha256:m1"]);
    expect(JSON.parse(calls[1]!.CHANT_HOLD_APPROVED!)).toEqual({ op: "other-op", gate: "db-migrate", digest: "sha256:m1", approvedBy: "alice", approvedAt: "2026-10-23T00:00:00Z" });
    expect(second.outcomes.map((o) => o.outcome)).toEqual(["held", "passed"]);
  });

  test("a re-run that holds on a gate already approved fails the stage (#4323)", async () => {
    const cwd = tmp();
    const exec: OpWaveExec = (_argv, _dir, env) => (writeFileSync(join(cwd, env!.CHANT_HOLD!), JSON.stringify(holdBody)), 1);
    const settle = async () => ({ status: "approved" as const, approvedBy: "alice", approvedAt: "t" });
    const ran = await runPrHooks({ base: "b", hooks: gateHooks }, "after-gate", place(cwd, exec), ["api"], undefined, { settle });
    expect(ran.failed).toMatch(/holds again on other-op \/ db-migrate at sha256:m1, which is already approved/);
  });

  test("without a settler a hold on another gate stays a plain hold", async () => {
    const cwd = tmp();
    const ran = await runPrHooks({ base: "b", hooks: gateHooks }, "after-gate", place(cwd, holdingExec(cwd, [])), ["api"]);
    expect(ran.holds).toEqual(["after-gate hook migrate (on other-op / db-migrate)"]);
    expect(ran.failed).toBeUndefined();
  });
});
