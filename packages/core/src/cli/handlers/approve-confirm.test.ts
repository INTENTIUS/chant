/**
 * `chant approve` at a terminal (#4575): the plan is shown, the target's name
 * is asked for, and only that answer records an approval of the plan shown.
 * Against temp repos; the terminal is faked (isTTY on stdin and stdout, and
 * readline's question). Nothing is pushed.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { withTestDir } from "@intentius/chant-test-utils";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { composeChangeSet, lifecyclePlanPart, type ChangeSetDocument } from "../../change-set";
import type { ChangeSet as LifecycleChangeSet } from "../../lifecycle/change-set";
import { persistChangeSet } from "../../lifecycle/change-set-store";
import { appendPendingGate, readGateLedger } from "../../lifecycle/gate-ledger";
import { resetGateOrigin } from "../../lifecycle/gate-origin";
import { CHANT_EXIT } from "../../exit-codes";
import type { ParsedArgs } from "../registry";

vi.mock("../../op/discover", () => ({ discoverOps: async () => ({ errors: [], ops: new Map() }) }));

/** The answers the faked terminal gives, in order; undefined is end of input. */
const answers: Array<string | undefined> = [];
const questions: string[] = [];
vi.mock("node:readline", () => ({
  createInterface: () => {
    let onClose: (() => void) | undefined;
    return {
      question: (q: string, cb: (a: string) => void) => {
        questions.push(q);
        const a = answers.shift();
        if (a === undefined) onClose?.();
        else cb(a);
      },
      close: () => undefined,
      on: (event: string, fn: () => void) => {
        if (event === "close") onClose = fn;
      },
    };
  },
}));

const { approvalTarget, confirmApproval, interactiveApproval } = await import("./approve-confirm");
const { runApprove } = await import("./approve");

const plan = JSON.parse(
  readFileSync(join(import.meta.dirname, "..", "..", "__fixtures__", "change-set", "lifecycle-plan.floci.json"), "utf8"),
) as LifecycleChangeSet;
const doc = (): ChangeSetDocument => composeChangeSet([lifecyclePlanPart({ member: "queues", plan })]);
const OTHER = `jcs1-sha256:${"e".repeat(64)}`;

function git(args: string[], cwd: string): void {
  spawnSync("git", args, { cwd, encoding: "utf-8" });
}

/** A repo whose gate `prod-apply` on `app-apply` waits in prod on a stored change set. */
async function repoWithGate(dir: string): Promise<ChangeSetDocument> {
  git(["init", "-q", "-b", "main"], dir);
  git(["config", "user.email", "t@chant.dev"], dir);
  git(["config", "user.name", "T"], dir);
  writeFileSync(join(dir, "README.md"), "x\n");
  git(["add", "."], dir);
  git(["commit", "-q", "-m", "init"], dir);
  const d = doc();
  await persistChangeSet(d, { cwd: dir });
  await appendPendingGate(
    {
      op: "app-apply",
      gate: "prod-apply",
      timestamp: "2026-10-27T00:00:00.000Z",
      expiresAt: "2999-01-01T00:00:00.000Z",
      planDigest: d.digest,
      environment: "prod",
      description: "apply the queues to prod",
    },
    { cwd: dir },
  );
  return d;
}

function ctx(args: Partial<ParsedArgs>) {
  return {
    args: { command: "approve", path: "app-apply", extraPositional: "prod-apply", format: "", fix: false, watch: false, verbose: false, help: false, live: false, actor: "alice", ...args } as ParsedArgs,
    plugins: [],
    serializers: [],
  };
}

const tty = { stdin: { isTTY: true }, stdout: { isTTY: true }, env: {} as Record<string, string | undefined> };

describe("interactiveApproval (#4575)", () => {
  afterEach(() => resetGateOrigin());

  test("a person at a terminal is asked", async () => {
    expect(await interactiveApproval({}, tty)).toBe(true);
  });

  test("--yes, --json, CI and a missing terminal are not", async () => {
    expect(await interactiveApproval({ yes: true }, tty)).toBe(false);
    expect(await interactiveApproval({ json: true }, tty)).toBe(false);
    expect(await interactiveApproval({}, { ...tty, env: { CI: "true" } })).toBe(false);
    expect(await interactiveApproval({}, { ...tty, stdin: { isTTY: false } })).toBe(false);
    expect(await interactiveApproval({}, { ...tty, stdout: {} })).toBe(false);
  });

  test("CI=false still asks", async () => {
    expect(await interactiveApproval({}, { ...tty, env: { CI: "false" } })).toBe(true);
  });
});

describe("approvalTarget (#4575)", () => {
  test("the fact's environment, else --env, else the gate", () => {
    expect(approvalTarget("prod-apply", { environment: "prod" }, "stage")).toBe("prod");
    expect(approvalTarget("prod-apply", {}, "stage")).toBe("stage");
    expect(approvalTarget("prod-apply", undefined)).toBe("prod-apply");
  });
});

describe("confirmApproval (#4575)", () => {
  const cwd = process.cwd();
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    process.chdir(cwd);
    resetGateOrigin();
    vi.restoreAllMocks();
  });

  test("shows the stored plan and confirms on the target's name", async () => {
    await withTestDir(async (dir) => {
      const d = await repoWithGate(dir);
      process.chdir(dir);
      let shown = "";
      const asked: string[] = [];
      const c = await confirmApproval("app-apply", "prod-apply", {
        cwd: dir,
        out: (t) => (shown += t),
        err: () => undefined,
        ask: async (q) => (asked.push(q), "prod"),
      });
      expect(c).toEqual({ status: "confirmed", plan: d.digest, target: "prod" });
      expect(shown).toContain(d.digest);
      expect(shown).toContain("apply the queues to prod");
      expect(shown).toContain("queues");
      expect(asked[0]).toContain("Type prod to approve");
    });
  });

  test("a wrong answer and end of input record nothing", async () => {
    await withTestDir(async (dir) => {
      await repoWithGate(dir);
      process.chdir(dir);
      for (const answer of ["staging", "", null]) {
        let said = "";
        const c = await confirmApproval("app-apply", "prod-apply", { cwd: dir, out: () => undefined, err: (t) => (said += t), ask: async () => answer });
        expect(c).toEqual({ status: "refused", code: CHANT_EXIT.declined });
        expect(said).toContain("the answer was not prod");
      }
    });
  });

  test("a plan that moves while the person is asked is not approved", async () => {
    await withTestDir(async (dir) => {
      await repoWithGate(dir);
      process.chdir(dir);
      const c = await confirmApproval("app-apply", "prod-apply", {
        cwd: dir,
        out: () => undefined,
        err: () => undefined,
        ask: async () => {
          await appendPendingGate(
            { op: "app-apply", gate: "prod-apply", timestamp: "2026-10-27T01:00:00.000Z", expiresAt: "2999-01-01T00:00:00.000Z", planDigest: OTHER, environment: "prod" },
            { cwd: dir },
          );
          return "prod";
        },
      });
      expect(c).toEqual({ status: "refused", code: CHANT_EXIT.moved });
    });
  });

  test("a gate with no pending fact and no --plan is left to the record, which refuses it", async () => {
    await withTestDir(async (dir) => {
      await repoWithGate(dir);
      process.chdir(dir);
      const ask = vi.fn(async () => "prod");
      expect(await confirmApproval("app-apply", "other-gate", { cwd: dir, out: () => undefined, err: () => undefined, ask })).toEqual({ status: "skipped" });
      expect(ask).not.toHaveBeenCalled();
    });
  });

  test("with no stored plan it says so and still asks for the digest", async () => {
    await withTestDir(async (dir) => {
      await repoWithGate(dir);
      process.chdir(dir);
      let said = "";
      const c = await confirmApproval("app-apply", "prod-apply", { cwd: dir, plan: OTHER, out: () => undefined, err: (t) => (said += t), ask: async () => "prod" });
      expect(c).toEqual({ status: "confirmed", plan: OTHER, target: "prod" });
      expect(said).toContain(`No plan is stored on chant/lifecycle under ${OTHER}`);
    });
  });
});

describe("chant approve with a faked terminal (#4575)", () => {
  const cwd = process.cwd();
  const stdinTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  const stdoutTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  beforeEach(() => {
    answers.length = 0;
    questions.length = 0;
    vi.stubEnv("CI", "");
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });
  afterEach(() => {
    process.chdir(cwd);
    if (stdinTTY) Object.defineProperty(process.stdin, "isTTY", stdinTTY);
    else delete (process.stdin as { isTTY?: boolean }).isTTY;
    if (stdoutTTY) Object.defineProperty(process.stdout, "isTTY", stdoutTTY);
    else delete (process.stdout as { isTTY?: boolean }).isTTY;
    vi.unstubAllEnvs();
    resetGateOrigin();
    vi.restoreAllMocks();
  });

  test("the target's name records an approval of the plan shown", async () => {
    await withTestDir(async (dir) => {
      const d = await repoWithGate(dir);
      process.chdir(dir);
      answers.push("prod");
      expect(await runApprove(ctx({}))).toBe(0);
      expect(questions).toHaveLength(1);
      const { resolutions } = await readGateLedger("app-apply", { cwd: dir });
      expect(resolutions).toEqual([expect.objectContaining({ resolvedBy: "alice", planDigest: d.digest, environment: "prod" })]);
    });
  });

  test("another answer records nothing and exits declined", async () => {
    await withTestDir(async (dir) => {
      await repoWithGate(dir);
      process.chdir(dir);
      answers.push("yes");
      expect(await runApprove(ctx({}))).toBe(CHANT_EXIT.declined);
      expect((await readGateLedger("app-apply", { cwd: dir })).resolutions).toEqual([]);
    });
  });

  test("--yes and --json record as before, without asking", async () => {
    for (const flags of [{ yes: true }, { json: true }]) {
      await withTestDir(async (dir) => {
        const d = await repoWithGate(dir);
        process.chdir(dir);
        expect(await runApprove(ctx(flags))).toBe(0);
        expect(questions).toEqual([]);
        expect((await readGateLedger("app-apply", { cwd: dir })).resolutions).toEqual([expect.objectContaining({ planDigest: d.digest })]);
      });
    }
  });

  test("no terminal records as before, without asking", async () => {
    await withTestDir(async (dir) => {
      const d = await repoWithGate(dir);
      process.chdir(dir);
      Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
      expect(await runApprove(ctx({}))).toBe(0);
      expect(questions).toEqual([]);
      expect((await readGateLedger("app-apply", { cwd: dir })).resolutions).toEqual([expect.objectContaining({ planDigest: d.digest })]);
    });
  });
});
