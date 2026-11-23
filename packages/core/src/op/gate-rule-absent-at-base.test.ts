/**
 * #5508: the identity rule for a gate is read at base. When the base has no
 * chant.workspace.json, the change being gated is the one that adds it, so its
 * `identity.gates` entry (`agentPassesAlone` included) does not judge it. The
 * gate runs under the default policy and says why; the entry applies from the
 * next change on. With no base at all, the working tree's declaration is still
 * read, since there is nothing reviewed to compare it with.
 */

import { afterEach, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { GateStep, OpConfig } from "./types";
import type { ActivityFn } from "./activity-registry";
import { resolveGateApproval, runOpLocally } from "./local-executor";
import { renderHuman } from "./local-output";
import { evaluateGate, gitGateLedgerPort, memoryGateLedgerPort, type GateLedgerPort } from "./gate";
import { gateContextDigest, gatePolicyVersion, type GatePolicyRef, type ResolvedGateApproval } from "./gate-approval";
import { rolesOf, type GateQuorumJudge } from "./gate-quorum";
import type { GateResolutionRecord, PendingGateRecord } from "../lifecycle/gate-ledger";
import { resetGateOrigin } from "../lifecycle/gate-origin";
import { GATE_RULE_NOT_AT_BASE, gateAdmission, gateRuleNotice, releaseRuleFrom, releaseRuleNoticeFrom } from "../workspace/identity";
import { scopeSource } from "../workspace/write-scope";

const TEXT = 'permit (principal is Chant::Agent, action, resource) when { context.risk == "low" };\n';
const POLICY: GatePolicyRef = { kind: "gate-policy", lexicon: "cedar", name: "ship", version: gatePolicyVersion(TEXT), text: TEXT };
const PLAN = `sha256:${"a".repeat(64)}`;
const NOW = "2026-09-01T12:00:00.000Z";
const STEP = { kind: "gate", gate: "ship", approval: { policy: POLICY, mode: "enforce", context: { risk: "low" } } } as unknown as GateStep;

const dirs: string[] = [];
const gitIn = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function newRepo(branch = "main"): string {
  const dir = mkdtempSync(join(tmpdir(), "gate-rule-at-base-"));
  dirs.push(dir);
  gitIn(dir, "init", "-q", "-b", branch);
  gitIn(dir, "config", "user.email", "t@example.com");
  gitIn(dir, "config", "user.name", "t");
  gitIn(dir, "config", "commit.gpgsign", "false");
  writeFileSync(join(dir, "README.md"), "a repository with no workspace declaration yet\n");
  gitIn(dir, "add", "README.md");
  gitIn(dir, "commit", "-q", "-m", "before chant");
  return dir;
}

const declaration = (identity?: Record<string, unknown>) =>
  `${JSON.stringify({ name: "acme", schema: 1, members: [], ...(identity ? { identity } : {}) }, null, 2)}\n`;
const GATES = { gates: { ship: { agentPassesAlone: true }, release: { class: "operator" } } };

function commitDeclaration(dir: string, text: string, message: string): void {
  writeFileSync(join(dir, "chant.workspace.json"), text);
  gitIn(dir, "add", "chant.workspace.json");
  gitIn(dir, "commit", "-q", "-m", message);
}

/** A repository whose main has no declaration, checked out on a change that adds one naming `ship` and `release`. */
function adoptingChange(): string {
  const dir = newRepo();
  gitIn(dir, "checkout", "-q", "-b", "adopt");
  commitDeclaration(dir, declaration(GATES), "adopt chant");
  return dir;
}

const pending = (approval: ResolvedGateApproval): PendingGateRecord => ({
  version: 1, kind: "pending", op: "release", gate: "ship",
  timestamp: "2026-09-01T00:00:00.000Z", expiresAt: "2026-09-03T00:00:00.000Z", planDigest: PLAN, approval,
});
const agentPermit: GateResolutionRecord = {
  version: 1, op: "release", gate: "ship", planDigest: PLAN, resolvedBy: "release-bot", timestamp: "2026-09-01T01:00:00.000Z",
  approver: { kind: "agent" },
  policyDecision: { policy: "ship", version: POLICY.version, mode: "enforce", contextDigest: gateContextDigest({ risk: "low" }), decision: "allow", determining: ["ship-0"], errors: [] },
};
const personApproval: GateResolutionRecord = {
  version: 1, op: "release", gate: "ship", planDigest: PLAN, resolvedBy: "alex", timestamp: "2026-09-01T02:00:00.000Z", approver: { kind: "human" },
};
const judge: GateQuorumJudge = (r) => ({ proven: true, roles: rolesOf(r.resolvedBy, {}) });

/** Decide `ship` as a run does: the rule from the git port at base, the approval block from it and the Op. */
async function decide(dir: string, resolutions: GateResolutionRecord[]) {
  const rule = await gitGateLedgerPort({ cwd: dir }).approvalRule!("ship");
  const approval = resolveGateApproval(STEP, new Map(), undefined, rule?.requirement.quorum, rule?.requirement)!;
  const port = memoryGateLedgerPort({ resolutions, pending: [pending(approval)] });
  const check = await evaluateGate(port, { op: "release", gate: "ship", planDigest: PLAN, approval, rule, now: NOW, judge });
  return { rule, approval, check };
}

afterEach(() => {
  resetGateOrigin();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("a change that adds chant.workspace.json (#5508)", () => {
  test("its identity.gates entry is not the gate's rule: the base has no declaration", async () => {
    const dir = adoptingChange();
    const source = scopeSource(dir);
    expect(source).toMatchObject({ from: "working-tree", base: gitIn(dir, "rev-parse", "main") });
    expect(gateAdmission(dir, "ship")).toBeNull();
    expect(await gitGateLedgerPort({ cwd: dir }).approvalRule!("ship")).toBeNull();
    // The base named explicitly reads the same.
    expect(gateAdmission(dir, "ship", "main")).toBeNull();
  });

  test("an agent's permit alone waits for a person, and passes beside a person's approval", async () => {
    const dir = adoptingChange();
    const alone = await decide(dir, [agentPermit]);
    expect(alone.rule).toBeNull();
    expect(alone.approval.agentPassesAlone).toBeUndefined();
    expect(alone.check.satisfied).toBe(false);

    const withPerson = await decide(dir, [agentPermit, personApproval]);
    expect(withPerson.check.satisfied).toBe(true);
  });

  test("the entry it adds would have let the permit through alone, which is what the base read prevents", async () => {
    const approval = resolveGateApproval(STEP, new Map(), undefined, null, { agentPassesAlone: true })!;
    const port = memoryGateLedgerPort({ resolutions: [agentPermit], pending: [pending(approval)] });
    expect((await evaluateGate(port, { op: "release", gate: "ship", planDigest: PLAN, approval, rule: null, now: NOW, judge })).satisfied).toBe(true);
  });

  test("the gate says the entry takes effect after the change merges", async () => {
    const dir = adoptingChange();
    const base = gitIn(dir, "rev-parse", "main");
    const notice = await gitGateLedgerPort({ cwd: dir }).approvalRuleNotice!("ship");
    expect(notice).toEqual({
      code: GATE_RULE_NOT_AT_BASE,
      gate: "ship",
      message: `identity.gates.ship in this change takes effect after it merges: base ${base.slice(0, 12)} has no chant.workspace.json, so this change is gated under the default policy`,
    });
    // A gate the change does not name gets no notice.
    expect(gateRuleNotice(dir, "rollout")).toBeNull();
  });

  test("a run's gate record carries the notice, and the run prints it", async () => {
    const dir = adoptingChange();
    const git = gitGateLedgerPort({ cwd: dir });
    const gates: GateLedgerPort = { ...memoryGateLedgerPort(), approvalRule: git.approvalRule, approvalRuleNotice: git.approvalRuleNotice };
    const config: OpConfig = {
      name: "release",
      overview: "",
      phases: [
        { name: "Gate", steps: [STEP] },
        { name: "Apply", steps: [{ kind: "activity", fn: "ship", args: {} }] },
      ],
    };
    const activities = new Map<string, ActivityFn>([["ship", async () => ({})]]);
    const run = await runOpLocally(config, activities, {}, undefined, { gates, now: NOW });
    expect(run.status).toBe("gated");
    expect(run.gate?.approval?.agentPassesAlone).toBeUndefined();
    const gateRecord = run.records.find((r) => r.phase === "Gate")!;
    expect(gateRecord.notice).toMatchObject({ code: GATE_RULE_NOT_AT_BASE });
    const lines: string[] = [];
    renderHuman(run, (l) => lines.push(l));
    expect(lines.join("\n")).toContain("[notice] identity.gates.ship in this change takes effect after it merges");
  });

  test("the release rule is absent for it too, with a notice", () => {
    const dir = adoptingChange();
    const source = scopeSource(dir);
    const read = releaseRuleFrom(source);
    expect(read.requirement).toBeNull();
    expect(read.rule.class).toBeNull();
    expect(releaseRuleNoticeFrom(source)?.message).toMatch(/^identity\.gates\.release in this change takes effect after it merges: base [0-9a-f]{12} has no chant\.workspace\.json, so a cut from it is judged under the default rule/);
  });
});

describe("once the declaration is at base (#5508)", () => {
  test("the next change is judged by the entry, with no notice", async () => {
    const dir = adoptingChange();
    gitIn(dir, "checkout", "-q", "main");
    gitIn(dir, "merge", "-q", "--ff-only", "adopt");
    gitIn(dir, "checkout", "-q", "-b", "next");
    writeFileSync(join(dir, "README.md"), "the next change\n");
    gitIn(dir, "commit", "-q", "-am", "next");

    expect(scopeSource(dir).from).toBe("base");
    const { rule, approval, check } = await decide(dir, [agentPermit]);
    expect(rule?.requirement.agentPassesAlone).toBe(true);
    expect(approval.agentPassesAlone).toBe(true);
    // The rule now judges approvals by their seal; an unsigned permit is named as refused rather than passing.
    expect(check.satisfied).toBe(false);
    if (!check.satisfied) expect(check.refused?.[0]?.resolution.resolvedBy).toBe("release-bot");
    expect(gateRuleNotice(dir, "ship")).toBeNull();
    expect(releaseRuleFrom(scopeSource(dir)).requirement).toMatchObject({ class: "operator" });
    expect(releaseRuleNoticeFrom(scopeSource(dir))).toBeNull();
  });

  test("an existing declaration that gains identity.gates is judged as before: by the base's, which names no gate", () => {
    const dir = newRepo();
    commitDeclaration(dir, declaration(), "chant, no gates");
    gitIn(dir, "checkout", "-q", "-b", "gates");
    commitDeclaration(dir, declaration(GATES), "add identity gates");

    expect(scopeSource(dir).from).toBe("base");
    expect(gateAdmission(dir, "ship")).toBeNull();
    expect(gateRuleNotice(dir, "ship")).toBeNull();
    expect(releaseRuleFrom(scopeSource(dir)).requirement).toBeNull();
    expect(releaseRuleNoticeFrom(scopeSource(dir))).toBeNull();
  });
});

describe("with no base to read at (#5508)", () => {
  test("a repository with no origin/HEAD, main or master reads the working tree's declaration, as before", () => {
    const dir = newRepo("trunk");
    commitDeclaration(dir, declaration(GATES), "adopt chant");
    const source = scopeSource(dir);
    expect(source.from).toBe("working-tree");
    expect(source.base).toBeUndefined();
    expect(gateAdmission(dir, "ship")?.requirement).toMatchObject({ agentPassesAlone: true });
    expect(releaseRuleFrom(source).requirement).toMatchObject({ class: "operator" });
    expect(gateRuleNotice(dir, "ship")).toBeNull();
  });

  test("a base named explicitly that names no commit reads no rule", () => {
    const dir = newRepo("trunk");
    commitDeclaration(dir, declaration(GATES), "adopt chant");
    expect(gateAdmission(dir, "ship", "origin/main")).toBeNull();
    expect(gateRuleNotice(dir, "ship", "origin/main")?.message).toContain("base origin/main has no chant.workspace.json");
  });
});
