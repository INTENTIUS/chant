/**
 * #4324: an Op gate's quorum is `identity.gates.<gate>.quorum` in the
 * workspace declaration at base, so a change can't lower the quorum its own
 * run needs, and a gate policy's `principal.roles` come from
 * `.chant/trust.json` at base for a proven approver, never from `chant
 * approve --role`.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import type { GateStep, OpConfig } from "./types";
import type { ActivityFn } from "./activity-registry";
import { resolveGateApproval, runOpLocally } from "./local-executor";
import { gitGateLedgerPort, memoryGateLedgerPort, type GateLedgerPort } from "./gate";
import type { GatePolicyEvaluator, GatePolicyRef, GatePolicyRequest } from "./gate-approval";
import { appendPendingGate, type GateResolutionInput } from "../lifecycle/gate-ledger";
import { resetGateOrigin } from "../lifecycle/gate-origin";
import { sealGateApproval } from "../workspace/trust/seal";
import { hasSshKeygen, TestRepo, type Key } from "../workspace/trust/test-repo";
import { recordGateApproval } from "../cli/handlers/approve";

const repos: TestRepo[] = [];
const home = process.cwd();
afterEach(() => {
  process.chdir(home);
  resetGateOrigin();
  while (repos.length) repos.pop()!.cleanup();
});

let keys: TestRepo;
let alice: Key;
let bob: Key;
beforeAll(() => {
  if (!hasSshKeygen) return;
  keys = new TestRepo("4324-keys");
  alice = keys.key("alice");
  bob = keys.key("bob");
});
afterAll(() => keys?.cleanup());

/** A repository whose `main` is the base, with a git identity the ledger writes can use. */
function repo(label: string, files: Record<string, string>): TestRepo {
  const r = new TestRepo(label);
  repos.push(r);
  r.git(["config", "user.email", "t@example.test"]);
  r.git(["config", "user.name", "t"]);
  r.git(["config", "commit.gpgsign", "false"]);
  for (const [path, text] of Object.entries(files)) r.write(path, text);
  r.commit("base");
  return r;
}

const declaration = (gates: Record<string, unknown>): string =>
  JSON.stringify({ name: "acme", schema: 1, members: [], identity: { gates } });

describe("resolveGateApproval reads the quorum at base (#4324)", () => {
  const step = (approval?: GateStep["approval"]): GateStep => ({ kind: "gate", gate: "ship", ...(approval ? { approval } : {}) }) as GateStep;

  test("the base quorum replaces the Op's own", () => {
    expect(resolveGateApproval(step({ quorum: { count: 1 } }), new Map(), undefined, { count: 2 })).toEqual({ quorum: { count: 2 }, mode: "log-only" });
  });

  test("a gate whose Op dropped its approval block still takes the base quorum", () => {
    expect(resolveGateApproval(step(), new Map(), undefined, { count: 2 })).toEqual({ quorum: { count: 2 }, mode: "log-only" });
  });

  test("a base list is matched against the run's environment", () => {
    const atBase = [{ targets: ["prod"], count: 2 }, { count: 1 }];
    expect(resolveGateApproval(step({ quorum: { count: 1 } }), new Map(), "prod", atBase)?.quorum).toEqual(atBase);
    expect(resolveGateApproval(step({ quorum: { count: 1 } }), new Map(), "dev", atBase)?.quorum).toEqual([{ count: 1 }]);
  });

  test("with no quorum at base, the Op's own applies", () => {
    expect(resolveGateApproval(step({ quorum: { count: 3 } }), new Map(), undefined, null)).toEqual({ quorum: { count: 3 }, mode: "log-only" });
    expect(resolveGateApproval(step(), new Map(), undefined, null)).toBeUndefined();
  });
});

describe.skipIf(!hasSshKeygen)("an Op gate's quorum at base (#4324)", () => {
  const NOW = "2026-10-23T12:00:00.000Z";
  const config = (count: number): OpConfig => ({
    name: "release",
    overview: "",
    phases: [
      { name: "Gate", steps: [{ kind: "gate", gate: "ship", approval: { quorum: { count } } }] },
      { name: "Apply", steps: [{ kind: "activity", fn: "ship", args: {} }] },
    ],
  });
  const activities = new Map<string, ActivityFn>([["ship", async () => ({})]]);

  test("a change that lowers its own quorum still needs the quorum at base", async () => {
    const r = repo("4324-quorum", {
      "chant.workspace.json": declaration({ ship: { quorum: { count: 2 } } }),
      ".chant/allowed_signers": `github:alice ${alice.pub}\ngithub:bob ${bob.pub}\n`,
    });
    // The pull request lowers both the declaration's quorum and the Op's.
    r.git(["checkout", "-q", "-b", "lower-quorum"]);
    r.write("chant.workspace.json", declaration({ ship: { quorum: { count: 1 } } }));
    r.commit("lower the quorum");

    const memory = memoryGateLedgerPort();
    const git = gitGateLedgerPort({ cwd: r.dir });
    const gates: GateLedgerPort = { ...memory, approvalRule: git.approvalRule, quorumJudge: git.quorumJudge };
    const approve = async (by: string, key: Key, timestamp: string) => {
      const line = { op: "release", gate: "ship", resolvedBy: by, timestamp, approver: { kind: "human" as const } };
      const input: GateResolutionInput = { ...line, seal: sealGateApproval(key.file, line) };
      await memory.appendResolution!(input);
    };

    const first = await runOpLocally(config(1), activities, {}, undefined, { gates, now: NOW });
    expect(first.status).toBe("gated");
    expect(first.gate?.approval?.quorum).toEqual({ count: 2 });
    expect(memory.appended[0]?.approval?.quorum).toEqual({ count: 2 });

    await approve("github:alice", alice, "2026-10-23T12:01:00.000Z");
    const second = await runOpLocally(config(1), activities, {}, undefined, { gates, now: "2026-10-23T12:02:00.000Z" });
    expect(second.status).toBe("gated");

    await approve("github:bob", bob, "2026-10-23T12:03:00.000Z");
    const third = await runOpLocally(config(1), activities, {}, undefined, { gates, now: "2026-10-23T12:04:00.000Z" });
    expect(third.status).toBe("ok");
    expect(third.records.find((rec) => rec.fn === "gate:ship")?.approval).toMatchObject({ via: "quorum", approvers: ["github:alice", "github:bob"] });
  });

  test("a gate the declaration names with no quorum keeps the Op's", async () => {
    const r = repo("4324-no-quorum", {
      "chant.workspace.json": declaration({ ship: {} }),
      ".chant/allowed_signers": `github:alice ${alice.pub}\n`,
    });
    const git = gitGateLedgerPort({ cwd: r.dir });
    const gates: GateLedgerPort = { ...memoryGateLedgerPort(), approvalRule: git.approvalRule };
    const run = await runOpLocally(config(3), activities, {}, undefined, { gates, now: NOW });
    expect(run.gate?.approval?.quorum).toEqual({ count: 3 });
  });
});

describe.skipIf(!hasSshKeygen)("a gate policy's roles come from trust.json at base (#4324)", () => {
  const POLICY: GatePolicyRef = { kind: "gate-policy", lexicon: "cedar", name: "ship", version: "sha256:v1", text: "permit when maintainer" };
  /** Permits only a principal with the maintainer role, and remembers what it was asked. */
  function maintainersOnly(): GatePolicyEvaluator & { asked: GatePolicyRequest[] } {
    const asked: GatePolicyRequest[] = [];
    return {
      asked,
      evaluateGatePolicy: (_policy, request) => {
        asked.push(request);
        return request.principal.roles.includes("maintainer")
          ? { decision: "allow", determining: ["maintainers"], errors: [] }
          : { decision: "deny", determining: [], errors: [] };
      },
    };
  }

  async function gated(): Promise<TestRepo> {
    const r = repo("4324-policy", {
      "README.md": "x\n",
      ".chant/allowed_signers": `github:alice ${alice.pub}\n`,
      ".chant/trust.json": JSON.stringify({ schema: 1, roles: { maintainer: ["github:alice"] } }),
    });
    await appendPendingGate(
      {
        op: "release",
        gate: "ship",
        timestamp: "2026-10-23T12:00:00.000Z",
        origin: "cli",
        expiresAt: "2999-01-01T00:00:00.000Z",
        approval: { policy: POLICY, mode: "enforce" },
      },
      { cwd: r.dir },
    );
    process.chdir(r.dir);
    return r;
  }

  test("a claimed --role the trust file does not grant fails a policy that requires it", async () => {
    const r = await gated();
    const evaluator = maintainersOnly();
    const outcome = await recordGateApproval("release", "ship", { origin: "cli", actor: "github:sam", roles: ["maintainer"], evaluator, cwd: r.dir });
    expect(outcome.ok).toBe(true);
    expect(evaluator.asked[0]?.principal).toEqual({ kind: "human", name: "github:sam", roles: [] });
    if (!outcome.ok) return;
    expect(outcome.record.policyDecision?.decision).toBe("deny");
    // The claim is still recorded, as data nothing trusts.
    expect(outcome.record.approver).toEqual({ kind: "human", roles: ["maintainer"] });
  });

  test("an unsealed approval by a granted principal gets no roles either", async () => {
    const r = await gated();
    const evaluator = maintainersOnly();
    const outcome = await recordGateApproval("release", "ship", { origin: "cli", actor: "github:alice", roles: ["maintainer"], evaluator, cwd: r.dir });
    expect(evaluator.asked[0]?.principal.roles).toEqual([]);
    expect(outcome.ok && outcome.record.policyDecision?.decision).toBe("deny");
  });

  test("a sealed approval gets the roles trust.json at base grants, and only those", async () => {
    const r = await gated();
    const evaluator = maintainersOnly();
    const outcome = await recordGateApproval("release", "ship", { origin: "cli", actor: "github:alice", roles: ["admin"], sign: alice.file, evaluator, cwd: r.dir });
    expect(evaluator.asked[0]?.principal).toEqual({ kind: "human", name: "github:alice", roles: ["maintainer"] });
    expect(outcome.ok && outcome.record.policyDecision?.decision).toBe("allow");
  });

  test("a grant the change adds to trust.json does not count until it is at base", async () => {
    const r = await gated();
    r.git(["checkout", "-q", "-b", "grant-sam"]);
    r.write(".chant/allowed_signers", `github:alice ${alice.pub}\ngithub:bob ${bob.pub}\n`);
    r.write(".chant/trust.json", JSON.stringify({ schema: 1, roles: { maintainer: ["github:alice", "github:bob"] } }));
    r.commit("grant bob");
    const evaluator = maintainersOnly();
    await recordGateApproval("release", "ship", { origin: "cli", actor: "github:bob", sign: bob.file, evaluator, cwd: r.dir });
    expect(evaluator.asked[0]?.principal.roles).toEqual([]);
  });
});
