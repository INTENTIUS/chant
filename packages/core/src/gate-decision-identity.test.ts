/**
 * #3862: `identityGateAdmissionAt` judges an `identity.gates` approval from a
 * bare clone at a base commit as chant's `gateAdmission(cwd, gate, base)`
 * does: the seal against the signers at base, and the class against the role
 * grants at base. Each fixture is judged both ways and the answers compared,
 * reasons included.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import {
  admitApprover,
  CORE_CLASSES,
  decideGateApproval,
  GATE_SEAL_NAMESPACE,
  gateSealPayload,
  identityGateAdmissionAt,
  type GateResolutionRecord,
} from "./gate-decision";
import { gateAdmission } from "./workspace/identity";
import { hasSshKeygen, TestRepo, type Key } from "./workspace/trust/test-repo";
import { evaluateGate, memoryGateLedgerPort } from "./op/gate";
import { gatePolicyVersion } from "./op/gate-approval";

const D1 = "sha256:" + "a".repeat(64);
const GATES = { ship: {}, deploy: { class: "human" }, release: { class: "runner" }, ops: { class: "operator" } };
const NAMES = [...Object.keys(GATES), "undeclared"];

describe.skipIf(!hasSshKeygen)("identity.gates read at base, as chant reads it", () => {
  const repos: TestRepo[] = [];
  afterEach(() => {
    while (repos.length) repos.pop()!.cleanup();
  });
  // Keys and seals are made once, by ssh-keygen, and shared by every fixture.
  let signer: TestRepo;
  let k: Record<"alice" | "bob" | "carol" | "mallory", Key>;
  const sigs = new Map<string, string>();
  beforeAll(() => {
    signer = new TestRepo("3862-keys");
    k = { alice: signer.key("alice"), bob: signer.key("bob"), carol: signer.key("carol"), mallory: signer.key("mallory") };
  });
  afterAll(() => signer.cleanup());
  const sign = (key: Key, payload: Buffer): string => {
    const id = `${key.name}\n${payload.toString("utf-8")}`;
    if (!sigs.has(id)) sigs.set(id, signer.sshSign(key, payload, GATE_SEAL_NAMESPACE));
    return sigs.get(id)!;
  };

  function setup(files: (k: Record<string, Key>) => Record<string, string>, declaration: Record<string, unknown> = {}) {
    const r = new TestRepo("3862-identity");
    repos.push(r);
    r.write("chant.workspace.json", JSON.stringify({ name: "acme", schema: 1, members: [], identity: { gates: GATES }, ...declaration }));
    for (const [path, text] of Object.entries(files(k))) r.write(path, text);
    const base = r.commit("base");
    // The change being applied lists mallory and makes alice a runner; neither counts at base.
    r.write(".chant/allowed_signers", `alice ${k.alice.pub}\nbob ${k.bob.pub}\nmallory ${k.mallory.pub}\n`);
    r.write(".chant/trust.json", JSON.stringify({ schema: 1, roles: { runner: ["alice", "bob"] } }));
    r.commit("widens the policy");
    const approval = (gate: string, resolvedBy: string, extra: Partial<GateResolutionRecord> = {}): GateResolutionRecord => ({
      version: 1, op: "web", gate, resolvedBy, timestamp: "2026-10-11T11:00:00.000Z", planDigest: D1, ...extra,
    });
    const seal = (a: GateResolutionRecord, key: Key, signer = a.resolvedBy): GateResolutionRecord => ({
      ...a,
      seal: { signer, key: "k", signature: sign(key, gateSealPayload(a)) },
    });
    const made = new Map<string, GateResolutionRecord[]>();
    const approvals = (gate: string): GateResolutionRecord[] => made.get(gate) ?? (made.set(gate, approvalsOf(gate)), made.get(gate)!);
    const approvalsOf = (gate: string): GateResolutionRecord[] => [
      approval(gate, "alice"),
      seal(approval(gate, "alice"), k.alice),
      seal(approval(gate, "BOB "), k.bob, "bob"),
      seal(approval(gate, "mallory"), k.mallory),
      seal(approval(gate, "carol"), k.carol),
      seal(approval(gate, "alice"), k.bob),
      seal(approval(gate, "alice"), k.alice, "bob"),
      { ...approval(gate, "alice"), seal: { signer: "alice" } as unknown as GateResolutionRecord["seal"] },
      { ...seal(approval(gate, "alice"), k.alice), planDigest: "sha256:" + "b".repeat(64) },
    ];
    return { r, base, approvals };
  }

  /** Every approval of every gate, judged by both readers: the pairs, and the reasons gate-decision gave. */
  function judgeBoth(r: TestRepo, base: string, approvals: (gate: string) => GateResolutionRecord[]) {
    const ours: Record<string, (string | null)[] | null> = {};
    for (const gate of NAMES) {
      const here = identityGateAdmissionAt(r.dir, base, gate);
      const chant = gateAdmission(r.dir, gate, base);
      expect(here === null, gate).toBe(chant === null);
      if (here === null || chant === null) {
        ours[gate] = null;
        continue;
      }
      expect(here.requirement).toEqual({ gate, class: chant.requirement.class });
      const reasons = approvals(gate).map((a) => here.refuses(a));
      expect(reasons, gate).toEqual(approvals(gate).map((a) => chant.refuses(a)));
      ours[gate] = reasons;
    }
    return ours;
  }

  test("signers, role grants and classes at base, approval by approval", () => {
    const { r, base, approvals } = setup((k) => ({
      ".chant/allowed_signers": `alice ${k.alice.pub}\nbob ${k.bob.pub}\ncarol namespaces="git" ${k.carol.pub}\n`,
      ".chant/trust.json": JSON.stringify({ schema: 1, roles: { runner: ["Bob"] } }),
    }));
    const ours = judgeBoth(r, base, approvals);
    expect(ours.undeclared).toBeNull();
    const passed = (gate: string) => ours[gate]!.flatMap((reason, i) => (reason === null ? [i] : []));
    // Any signer: alice and bob, each with their own key. Not mallory (listed after base), not carol (no chant-gate namespace).
    expect(passed("ship")).toEqual([1, 2]);
    // human: alice; bob holds the runner role at base.
    expect(passed("deploy")).toEqual([1]);
    expect(ours.deploy![2]).toMatch(/^BOB  is not in the class human that gate deploy needs/);
    // runner: bob, by the grant at base; alice's grant comes after base.
    expect(passed("release")).toEqual([2]);
    expect(ours.release![1]).toBe("alice is not in the class runner that gate release needs: no role grant at base puts them there");
    // operator: no pinned package supplies it.
    expect(passed("ops")).toEqual([]);
    expect(ours.ops![1]).toMatch(/names the class operator, which no pinned package supplies, .*known classes: human, agent, runner, service/);
    expect(ours.ship![0]).toBe("the approval by alice is not signed; gate ship needs chant approve --sign");
    expect(ours.ship![3]).toBe("mallory has no key in .chant/allowed_signers at base, so the seal can't count");
    expect(ours.ship![4]).toMatch(/^the seal does not verify for carol against \.chant\/allowed_signers at base/);
  });

  test("a signers path trust.json names", () => {
    const named = setup((k) => ({
      ".chant/trust.json": JSON.stringify({ schema: 1, signers: "ops/signers", roles: { runner: ["alice"] } }),
      "ops/signers": `alice ${k.alice.pub}\n`,
    }));
    expect(judgeBoth(named.r, named.base, named.approvals).release![1]).toBeNull();
  });

  test("no signers file at base, and a trust.json chant refuses", () => {
    const none = setup(() => ({ "README.md": "x\n" }));
    expect(judgeBoth(none.r, none.base, none.approvals).ship![1]).toBe("gate ship needs a signed approval, and there is no signers file (.chant/allowed_signers) at base to check one against");

    const invalid = setup((k) => ({
      ".chant/trust.json": JSON.stringify({ schema: 1, roles: { Admin: ["alice"] } }),
      ".chant/allowed_signers": `alice ${k.alice.pub}\n`,
    }));
    expect(judgeBoth(invalid.r, invalid.base, invalid.approvals).ship![1]).toMatch(/no signers file/);
  });

  /** A plugin publishing `classes` at ./workspace-principals, as files under `dir`. */
  const plugin = (dir: string, classes: unknown[], version = "1.0.0"): Record<string, string> => ({
    [`${dir}/package.json`]: JSON.stringify({ name: "@acme/ops-classes", version, exports: { "./workspace-principals": "./principals.json" } }),
    [`${dir}/principals.json`]: JSON.stringify({ schema: 1, classes }),
  });
  const OPERATOR = { name: "operator", description: "people who apply infrastructure", role: "operator" };
  const operatorPolicy = (k: Record<string, Key>) => ({
    ".chant/allowed_signers": `alice ${k.alice.pub}\nbob ${k.bob.pub}\n`,
    ".chant/trust.json": JSON.stringify({ schema: 1, roles: { operator: ["alice"], runner: ["bob"] } }),
  });
  const install = (r: TestRepo, files: Record<string, string>) => {
    for (const [path, text] of Object.entries(files)) r.write(path, text);
  };

  test("a class only a pinned package supplies, read from the installed package as chant reads it (#3888)", () => {
    const { r, base, approvals } = setup(operatorPolicy, { pins: [{ package: "@acme/ops-classes", version: "1.0.0" }] });
    install(r, plugin("node_modules/@acme/ops-classes", [OPERATOR]));
    const ours = judgeBoth(r, base, approvals);
    // alice holds the operator role at base, so she is an operator and no longer human.
    expect(ours.ops![1]).toBeNull();
    expect(ours.ops![2]).toBe("BOB  is not in the class operator that gate ops needs: no role grant at base puts them there");
    expect(ours.deploy![1]).toMatch(/^alice is not in the class human that gate deploy needs/);

    // A bare clone holds no node_modules; the caller names where the packages are installed.
    const bare = `${r.dir}.git`;
    r.git(["clone", "-q", "--bare", r.dir, bare]);
    const fromBare = identityGateAdmissionAt(bare, base, "ops", { packages: r.dir })!;
    expect(approvals("ops").map((a) => fromBare.refuses(a))).toEqual(ours.ops);
  });

  test("a path pin's class is read at base, so the change being applied can't remap it", () => {
    const { r, base, approvals } = setup((k) => ({ ...operatorPolicy(k), ...plugin("plugins/ops", [OPERATOR]) }), { pins: [{ path: "plugins/ops" }] });
    // After base the plugin moves the operator class to bob's role; base still says operator.
    install(r, plugin("plugins/ops", [{ ...OPERATOR, role: "runner-ops" }]));
    r.commit("remaps operator");
    const ours = judgeBoth(r, base, approvals);
    expect(ours.ops![1]).toBeNull();
  });

  test("a pin it cannot read refuses a gate whose class the pin could change, and says why", () => {
    const { r, base, approvals } = setup(operatorPolicy, { pins: [{ package: "@acme/ops-classes", version: "1.0.0" }] });
    const missing = identityGateAdmissionAt(r.dir, base, "ops")!;
    expect(missing.refuses(approvals("ops")[1])).toBe(
      `identity.gates.ops names the class operator, and the pins in chant.workspace.json at base could not all be read, so no approval can show it is in that class: @acme/ops-classes is not installed under ${r.dir}`,
    );
    // human is everyone in no other class, so an unread pin leaves it unknown too; runner and no class are not affected.
    expect(identityGateAdmissionAt(r.dir, base, "deploy")!.refuses(approvals("deploy")[1])).toMatch(/names the class human, and the pins .* could not all be read/);
    expect(identityGateAdmissionAt(r.dir, base, "release")!.refuses(approvals("release")[2])).toBeNull();
    expect(identityGateAdmissionAt(r.dir, base, "ship")!.refuses(approvals("ship")[1])).toBeNull();

    install(r, plugin("node_modules/@acme/ops-classes", [OPERATOR], "2.0.0"));
    expect(identityGateAdmissionAt(r.dir, base, "ops")!.refuses(approvals("ops")[1])).toMatch(/: @acme\/ops-classes is pinned at 1\.0\.0, and 2\.0\.0 is installed under /);

    // A class the caller read stands for the pins, as before.
    const read = identityGateAdmissionAt(r.dir, base, "ops", { classes: [{ name: "operator", role: "operator" }] })!;
    expect(read.refuses(approvals("ops")[1])).toBeNull();
    expect(read.refuses(approvals("ops")[0])).toMatch(/not signed/);
  });

  test("an installed package that supplies no such class refuses as chant does", () => {
    const { r, base, approvals } = setup(operatorPolicy, { pins: [{ package: "@acme/ops-classes", version: "1.0.0" }] });
    install(r, plugin("node_modules/@acme/ops-classes", [{ ...OPERATOR, name: "deployer" }]));
    expect(judgeBoth(r, base, approvals).ops![1]).toMatch(/names the class operator, which no pinned package supplies, .*known classes: human, agent, runner, service, deployer/);
  });

  test("passed to decideGateApproval as refuses, it counts what chant's wave gate counts", async () => {
    const { r, base, approvals } = setup((k) => ({
      ".chant/allowed_signers": `alice ${k.alice.pub}\nbob ${k.bob.pub}\n`,
      ".chant/trust.json": JSON.stringify({ schema: 1, roles: { runner: ["bob"] } }),
    }));
    const here = identityGateAdmissionAt(r.dir, base, "release")!;
    const chant = gateAdmission(r.dir, "release", base)!;
    for (const resolutions of [approvals("release").slice(0, 2), approvals("release")]) {
      const decided = decideGateApproval({ ledger: { pending: [], resolutions }, gate: "release", planDigest: D1, refuses: here.refuses, now: "2026-10-11T12:00:00.000Z" });
      const port = { ...memoryGateLedgerPort({ pending: [], resolutions }), approvalRule: async () => chant };
      const check = await evaluateGate(port, { op: "web", gate: "release", planDigest: D1, now: "2026-10-11T12:00:00.000Z" });
      expect(decided.status === "approved" && decided.via === "ledger" ? decided.resolution : null).toEqual(check.satisfied ? check.resolution : null);
    }
  });

  test("a gate's quorum at base, as chant reads it (#4324)", () => {
    const rules = [{ targets: ["prod"], count: 2, roles: ["platform"] }, { count: 1 }];
    const { r, base } = setup(() => ({}), { identity: { gates: { ship: { quorum: rules }, deploy: { class: "human" } } } });
    const here = identityGateAdmissionAt(r.dir, base, "ship")!;
    expect(here.requirement.quorum).toEqual(rules);
    expect(here.requirement.quorum).toEqual(gateAdmission(r.dir, "ship", base)!.requirement.quorum);
    expect(identityGateAdmissionAt(r.dir, base, "deploy")!.requirement).toEqual({ gate: "deploy", class: "human" });
  });

  test("a gate's policy, mode and context at base, as chant reads them (#4404)", () => {
    const text = "permit (principal, action, resource);";
    const policy = { kind: "gate-policy", lexicon: "cedar", name: "ship", version: gatePolicyVersion(text), text };
    const { r, base } = setup(() => ({}), { identity: { gates: { ship: { policy, mode: "enforce", context: { risk: "high" } } } } });
    const here = identityGateAdmissionAt(r.dir, base, "ship")!.requirement;
    const theirs = gateAdmission(r.dir, "ship", base)!.requirement;
    expect(here).toMatchObject({ policy, mode: "enforce", context: { risk: "high" } });
    expect({ policy: here.policy, mode: here.mode, context: here.context }).toEqual({ policy: theirs.policy, mode: theirs.mode, context: theirs.context });
  });
});

describe("admitApprover", () => {
  test("is the rule gateAdmission judges by: a class it does not know refuses before the seal is read", () => {
    const rule = { gate: "ship", class: "operator", signers: { signersPath: ".chant/allowed_signers", active: false, signers: [] }, roles: {}, classes: CORE_CLASSES };
    expect(admitApprover(rule, { op: "web", gate: "ship", resolvedBy: "alice", timestamp: "t" })).toMatch(/no pinned package supplies/);
    expect(admitApprover({ ...rule, class: null }, { op: "web", gate: "ship", resolvedBy: "alice", timestamp: "t" })).toMatch(/no signers file/);
  });
});
