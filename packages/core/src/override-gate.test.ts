/**
 * #3760: the override gate decides a denied plan's override: bound to the
 * subject, plan digest and rules, by someone the overriders at base list,
 * with a reason, sealed under `sealed`, and spent once a run applies it.
 */

import { createHash } from "node:crypto";
import { afterEach, describe, expect, test } from "vitest";
import {
  OVERRIDE_APPLIED,
  OVERRIDE_OP,
  appliedOverride,
  decideOverride,
  overrideAuditApplies,
  overrideCommand,
  overrideDigest,
  overridePending,
  overridersAt,
  parseAppliedOverrides,
  parseOverriders,
  recordedDenials,
  sortedRules,
  type AppliedOverrideRecord,
  type GateResolutionRecord,
  type OverrideInput,
  type PendingGateRecord,
} from "./override-gate";
import { baseCommit, gateSealPayload, gateSignersAt, GATE_SEAL_NAMESPACE } from "./gate-decision";
import { deriveGateAudit, gateLedgerLines, isOverrideGate, POLICY_OVERRIDE_OP } from "./lifecycle/gate-audit";
import { isNeverOverMcpGateOp } from "./op/gate-name";
import { isPlanDigest } from "./lifecycle/plan-digest";
import { hasSshKeygen, TestRepo } from "./workspace/trust/test-repo";

const ROOT = "envs/prod/vpc";
const PLAN = `sha256:${"a".repeat(64)}`;
const PLAN2 = `sha256:${"b".repeat(64)}`;
const RULES = ["no-public-s3", "cost-cap"];
const NOW = "2026-10-11T12:00:00.000Z";
const DIGEST = overrideDigest(ROOT, PLAN, RULES);

const denial = (timestamp: string, plan = PLAN, rules = RULES, expiresAt = "2026-10-13T00:00:00.000Z"): PendingGateRecord =>
  overridePending({ subject: ROOT, planDigest: plan, rules, timestamp, expiresAt });
const override = (timestamp: string, extra: Partial<GateResolutionRecord> = {}): GateResolutionRecord => ({
  version: 1, op: OVERRIDE_OP, gate: ROOT, resolvedBy: "github:alice", timestamp, planDigest: DIGEST, note: "the bucket is the public docs site", ...extra,
});
const input = (resolutions: GateResolutionRecord[], over: Partial<OverrideInput> = {}): OverrideInput => ({
  ledger: { pending: [denial("2026-10-11T10:00:00.000Z")], resolutions },
  subject: ROOT, planDigest: PLAN, rules: RULES, overriders: ["github:alice", "github:bob"], now: NOW, ...over,
});

describe("the digest", () => {
  test("binds the subject, the plan and the sorted rules, as terragucci's override.ts does", () => {
    const expected = `sha256:${createHash("sha256").update([OVERRIDE_OP, ROOT, PLAN, "cost-cap", "no-public-s3"].join("\n")).digest("hex")}`;
    expect(DIGEST).toBe(expected);
    expect(isPlanDigest(DIGEST)).toBe(true);
    expect(overrideDigest(ROOT, PLAN, [" no-public-s3", "cost-cap", "cost-cap"])).toBe(DIGEST);
    expect(overrideDigest(ROOT, PLAN2, RULES)).not.toBe(DIGEST);
    expect(overrideDigest(ROOT, PLAN, ["cost-cap"])).not.toBe(DIGEST);
    expect(overrideDigest("envs/dev/vpc", PLAN, RULES)).not.toBe(DIGEST);
  });

  test("the command names each rule and asks for a reason, and a sign under sealed", () => {
    expect(sortedRules(["b", " a", "b", ""])).toEqual(["a", "b"]);
    expect(overrideCommand(ROOT, RULES)).toBe(`chant approve policy-override ${ROOT} --rule cost-cap --rule no-public-s3 --reason "<why>"`);
    expect(overrideCommand(ROOT, RULES, true)).toMatch(/ --sign$/);
  });
});

describe("the denial", () => {
  test("is a pending fact of the override op whose planDigest is the override digest, with the plan and rules", () => {
    const p = denial("2026-10-11T10:00:00.000Z") as PendingGateRecord & { plan: string; rules: string[] };
    expect(p).toMatchObject({ version: 1, kind: "pending", op: "policy-override", gate: ROOT, planDigest: DIGEST, plan: PLAN, rules: ["cost-cap", "no-public-s3"] });
  });

  test("recordedDenials keeps each subject's newest", () => {
    const other = overridePending({ subject: "envs/dev/vpc", planDigest: PLAN, rules: ["x"], timestamp: "2026-10-11T09:00:00.000Z", expiresAt: NOW });
    const ds = recordedDenials([denial("2026-10-11T08:00:00.000Z", PLAN2), denial("2026-10-11T10:00:00.000Z"), other, { ...other, op: "tf-apply" }]);
    expect(ds.map((d) => [d.gate, d.plan])).toEqual([["envs/dev/vpc", PLAN], [ROOT, PLAN]]);
  });

  test("the override op is never resolved over MCP, and the audit reader reads it as overrides", () => {
    expect(isNeverOverMcpGateOp(OVERRIDE_OP)).toBe(true);
    expect(OVERRIDE_OP).toBe(POLICY_OVERRIDE_OP);
    expect(isOverrideGate(OVERRIDE_OP, ROOT)).toBe(true);
  });
});

describe("decideOverride", () => {
  test("an override of this digest, after the denial, by a listed person with a reason, counts", () => {
    const d = decideOverride(input([override("2026-10-11T11:00:00.000Z")]));
    expect(d).toMatchObject({ status: "overridden", digest: DIGEST, override: { subject: ROOT, by: "github:alice", reason: "the bucket is the public docs site", rules: ["cost-cap", "no-public-s3"], planDigest: PLAN, sealed: false } });
  });

  test("overriders are matched as signers are: case and width folded", () => {
    expect(decideOverride(input([override("2026-10-11T11:00:00.000Z", { resolvedBy: "GitHub:Alice" })])).status).toBe("overridden");
  });

  test.each<[string, Partial<GateResolutionRecord> & { via?: string }, RegExp]>([
    ["someone not listed", { resolvedBy: "github:mallory" }, /github:mallory is not listed in \.chant\/overriders at base \(github:alice, github:bob\)/],
    ["no reason", { note: "  " }, /gives no reason/],
    ["a job's line", { via: "slack" }, /written by a job \(via slack\)/],
    ["a review's line", { review: { pr: 7, head: "c".repeat(40), approvers: ["github:alice"] } }, /review of #7/],
    ["an agent", { approver: { kind: "agent" } }, /recorded by an agent/],
  ])("%s does not count, and says why", (_name, extra, why) => {
    const d = decideOverride(input([override("2026-10-11T11:00:00.000Z", extra)]));
    expect(d.status).toBe("none");
    expect(d.status === "none" && d.refusals).toEqual([expect.stringMatching(why)]);
  });

  test("nobody is listed when the overriders file is missing", () => {
    const d = decideOverride(input([override("2026-10-11T11:00:00.000Z")], { overriders: [], overridersPath: "yodel.config.ts" }));
    expect(d.status === "none" && d.refusals[0]).toMatch(/not listed in yodel\.config\.ts at base, which lists nobody/);
  });

  test("an override from before the newest denial answers nothing", () => {
    const d = decideOverride(input([override("2026-10-11T09:00:00.000Z")]));
    expect(d).toMatchObject({ status: "none", refusals: [] });
  });

  test("an override of another plan or other rules is the moved refusal", () => {
    const was = overrideDigest(ROOT, PLAN2, RULES);
    const d = decideOverride(input([override("2026-10-11T11:00:00.000Z", { planDigest: was })]));
    expect(d).toMatchObject({ status: "moved", by: "github:alice", was, digest: DIGEST });
  });

  test("the standing denial is reported, so a run records no second one; an expired one is not", () => {
    const standing = decideOverride(input([]));
    expect(standing.status === "none" && standing.standing?.planDigest).toBe(DIGEST);
    const expired = decideOverride(input([], { ledger: { pending: [denial("2026-10-08T10:00:00.000Z", PLAN, RULES, "2026-10-09T00:00:00.000Z")], resolutions: [] } }));
    expect(expired.status === "none" && expired.standing).toBeUndefined();
    const otherPlan = decideOverride(input([], { planDigest: PLAN2 }));
    expect(otherPlan.status === "none" && otherPlan.standing).toBeUndefined();
  });

  test("an override written after an expired denial still counts for the same plan", () => {
    const ledger = { pending: [denial("2026-10-08T10:00:00.000Z", PLAN, RULES, "2026-10-09T00:00:00.000Z")], resolutions: [override("2026-10-10T11:00:00.000Z")] };
    expect(decideOverride(input([], { ledger })).status).toBe("overridden");
  });

  describe("spent once applied", () => {
    const first = override("2026-10-11T11:00:00.000Z");
    const decided = decideOverride(input([first]));
    if (decided.status !== "overridden") throw new Error("setup");
    const applied = appliedOverride(decided.override, { timestamp: "2026-10-11T11:05:00.000Z", runId: "42", commit: "c".repeat(40) });

    test("the applied record names the subject, the override digest and the override's time", () => {
      expect(applied).toEqual({ version: 1, kind: "applied", op: OVERRIDE_OP, gate: ROOT, planDigest: DIGEST, approvedAt: first.timestamp, approvedBy: "github:alice", timestamp: "2026-10-11T11:05:00.000Z", runId: "42", commit: "c".repeat(40) });
      expect(parseAppliedOverrides(`${JSON.stringify(applied)}\nnot json\n{"version":1,"kind":"finished"}\n`)).toEqual([applied]);
    });

    test("a spent override does not count for the same plan again", () => {
      const d = decideOverride(input([first], { applied: [applied] }));
      expect(d.status === "none" && d.refusals).toEqual([expect.stringMatching(/is spent: a run applied under it at 2026-10-11T11:05:00/)]);
    });

    test("an override written after the applied record counts", () => {
      const again = override("2026-10-11T11:10:00.000Z", { resolvedBy: "github:bob" });
      expect(decideOverride(input([first, again], { applied: [applied] }))).toMatchObject({ status: "overridden", override: { by: "github:bob" } });
    });

    test("a re-planned denial waits for its own override, and the spent one is not a moved plan", () => {
      const ledger = { pending: [denial("2026-10-11T10:00:00.000Z"), denial("2026-10-11T10:30:00.000Z", PLAN2)], resolutions: [first] };
      // Not newer than the new denial: nothing.
      expect(decideOverride(input([], { ledger, planDigest: PLAN2, applied: [applied] }))).toMatchObject({ status: "none", refusals: [] });
      // Written after the new denial, but for the old plan and already spent.
      const late = override("2026-10-11T10:40:00.000Z");
      const spentLater: AppliedOverrideRecord = { ...applied, approvedAt: late.timestamp };
      const d = decideOverride(input([], { ledger: { ...ledger, resolutions: [late] }, planDigest: PLAN2, applied: [spentLater] }));
      expect(d).toMatchObject({ status: "none", spent: { digest: DIGEST, by: "github:alice", at: late.timestamp } });
      // The same line, never applied, is the moved refusal.
      expect(decideOverride(input([], { ledger: { ...ledger, resolutions: [late] }, planDigest: PLAN2 })).status).toBe("moved");
    });

    test("the audit reader records the override and its spending", () => {
      const ledgerText = [denial("2026-10-11T10:00:00.000Z"), first].map((l) => JSON.stringify(l)).join("\n");
      const { entries, gaps } = deriveGateAudit({ ledgers: [{ op: OVERRIDE_OP, lines: gateLedgerLines(ledgerText) }], applies: overrideAuditApplies([applied]) });
      expect(entries.map((e) => e.kind)).toEqual(["override-requested", "override-recorded", "applied", "override-spent"]);
      expect(entries.find((e) => e.kind === "override-recorded")).toMatchObject({ rules: ["cost-cap", "no-public-s3"], note: "the bucket is the public docs site", digest: DIGEST });
      expect(entries.find((e) => e.kind === "applied")?.source.path).toBe(`${OVERRIDE_APPLIED}:1`);
      expect(gaps).toEqual([]);
    });
  });
});

describe("the overriders at base", () => {
  const repos: TestRepo[] = [];
  afterEach(() => {
    while (repos.length) repos.pop()!.cleanup();
  });

  test("one principal per line, comments and blanks skipped", () => {
    expect(parseOverriders("# who may override\ngithub:alice\n\n  github:bob  # on call\ngithub:alice\n")).toEqual(["github:alice", "github:bob"]);
  });

  test("are read at base, so the change being applied cannot add its own overrider", () => {
    const r = new TestRepo("3760-overriders");
    repos.push(r);
    r.write(".chant/overriders", "github:alice\n");
    r.commit("base");
    r.write(".chant/overriders", "github:alice\ngithub:mallory\n");
    r.commit("adds mallory");
    const base = baseCommit(r.dir);
    expect(overridersAt(r.dir, base)).toEqual({ base, path: ".chant/overriders", active: true, principals: ["github:alice"] });
    expect(overridersAt(r.dir, base, "ops/overriders").active).toBe(false);
  });
});

describe.skipIf(!hasSshKeygen)("sealed", () => {
  const repos: TestRepo[] = [];
  afterEach(() => {
    while (repos.length) repos.pop()!.cleanup();
  });

  test("only an override sealed by its overrider's key at base counts", () => {
    const r = new TestRepo("3760-sealed");
    repos.push(r);
    const alice = r.key("alice");
    const bob = r.key("bob");
    r.write(".chant/allowed_signers", `github:alice ${alice.pub}\n`);
    r.commit("base");
    r.write(".chant/allowed_signers", `github:alice ${alice.pub}\ngithub:bob ${bob.pub}\n`);
    r.commit("adds bob");
    const signers = gateSignersAt(r.dir, baseCommit(r.dir));
    const seal = (o: GateResolutionRecord, key = alice) => ({ ...o, seal: { signer: o.resolvedBy, key: "k", signature: r.sshSign(key, gateSealPayload(o), GATE_SEAL_NAMESPACE) } });

    const unsealed = override("2026-10-11T11:00:00.000Z");
    expect(decideOverride(input([unsealed], { mode: "sealed", signers })).status === "none").toBe(true);
    expect(decideOverride(input([seal(unsealed)], { mode: "sealed", signers }))).toMatchObject({ status: "overridden", override: { sealed: true } });
    // Bob is listed as an overrider, but his key is added by the change itself.
    const byBob = seal(override("2026-10-11T11:00:00.000Z", { resolvedBy: "github:bob" }), bob);
    const d = decideOverride(input([byBob], { mode: "sealed", signers }));
    expect(d.status === "none" && d.refusals[0]).toMatch(/github:bob has no key in \.chant\/allowed_signers at base/);
    // A seal binds the digest, so a sealed line edited to another digest does not verify.
    const moved = { ...seal(unsealed), planDigest: overrideDigest(ROOT, PLAN, ["cost-cap"]) };
    expect(decideOverride(input([moved], { mode: "sealed", signers, rules: ["cost-cap"], ledger: { pending: [], resolutions: [moved] } })).status).toBe("none");
    // Under sealed with no signers read, nothing counts.
    expect(decideOverride(input([seal(unsealed)], { mode: "sealed" })).status).toBe("none");
  });
});
