/**
 * #3163, ws-080: person-attributed records and gate approvals rest on a forge
 * identity or a signer key, and a gate the declaration names passes only on a
 * signed approval from its class.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { parseDeclaration, type Declaration } from "./declaration";
import { forgePrincipal, gateAdmissionFrom, identify, IdentityError, parseForgeIdentity, refuseUnidentified } from "./identity";
import { createClassRegistry, coreClassRegistry } from "./principal-classes";
import { reviewRecord } from "./records-write";
import { answerPoint } from "./decide";
import { gatesInLedger } from "./status-gates";
import { emptyPolicy, type TrustPolicy } from "./trust/policy";
import { sealGateApproval } from "./trust/seal";
import { hasSshKeygen, TestRepo, type Key } from "./trust/test-repo";
import { evaluateGate, memoryGateLedgerPort } from "../op/gate";
import type { GateResolutionRecord, PendingGateRecord } from "../lifecycle/gate-ledger";

const decl = (identity: unknown): Declaration =>
  parseDeclaration(JSON.stringify({ name: "acme", schema: 1, members: [], identity }), "chant.workspace.json", "0.102.0");

const policyWith = (signers: { principal: string; key: string }[], roles: Record<string, string[]> = {}): TrustPolicy => ({
  ...emptyPolicy("0".repeat(40)),
  active: true,
  signers: signers.map((s, i) => ({ ...s, line: i + 1 })),
  roles,
});

const repos: TestRepo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.cleanup();
});

describe("forge identities", () => {
  test("github and gitlab name their own host; forgejo and gitea name one", () => {
    expect(parseForgeIdentity("github:Alice")).toEqual({ forge: "github", host: "github.com", login: "alice" });
    expect(parseForgeIdentity("gitlab:a.b_c")).toEqual({ forge: "gitlab", host: "gitlab.com", login: "a.b_c" });
    expect(parseForgeIdentity("forgejo@codeberg.org:bob")).toEqual({ forge: "forgejo", host: "codeberg.org", login: "bob" });
    expect(parseForgeIdentity("github@ghe.example.com:carol")).toEqual({ forge: "github", host: "ghe.example.com", login: "carol" });
    expect(parseForgeIdentity("forgejo:bob")).toBeNull();
    expect(parseForgeIdentity("alice")).toBeNull();
    expect(parseForgeIdentity("alice@example.com")).toBeNull();
    expect(parseForgeIdentity("github:")).toBeNull();
    expect(parseForgeIdentity("bitbucket:alice")).toBeNull();
    expect(forgePrincipal({ forge: "github", host: "github.com", login: "alice" })).toBe("github:alice");
    expect(forgePrincipal({ forge: "forgejo", host: "codeberg.org", login: "bob" })).toBe("forgejo@codeberg.org:bob");
  });

  test("a principal is a signer, a forge identity, a role holder or a name", () => {
    const policy = policyWith([{ principal: "github:alice", key: "ssh-ed25519 AAAA" }, { principal: "dana@example.test", key: "ssh-ed25519 BBBB" }], { runner: ["ci-bot"] });
    expect(identify("GitHub:Alice", policy).form).toBe("signer");
    expect(identify("dana@example.test", policy).form).toBe("signer");
    expect(identify("github:bob", policy).form).toBe("forge");
    expect(identify("ci-bot", policy).form).toBe("role");
    expect(identify("alex", policy).form).toBe("name");
    const d = parseDeclaration(
      JSON.stringify({ name: "acme", schema: 1, members: [{ name: "app", dir: "app", kind: "chant" }], agents: [{ name: "builder", member: "app", principals: ["builder-bot"] }] }),
      "chant.workspace.json",
      "0.102.0",
    );
    expect(identify("builder-bot", emptyPolicy(null), d).form).toBe("role");
  });
});

describe("identity.attribution", () => {
  test("parses, and defaults to any", () => {
    expect(decl({}).identity).toEqual({ attribution: "any", gates: {} });
    expect(decl({ attribution: "identified", gates: { ship: { class: "operator" }, rollback: {} } }).identity).toEqual({
      attribution: "identified",
      gates: {
        ship: { gate: "ship", class: "operator", pointer: "/identity/gates/ship" },
        rollback: { gate: "rollback", class: null, pointer: "/identity/gates/rollback" },
      },
    });
    expect(() => decl({ attribution: "verified" })).toThrow();
    expect(() => decl({ gates: { ship: { by: "x" } } })).toThrow();
  });

  test("identified refuses a bare name and takes a forge identity or a signer", () => {
    const source = { declaration: decl({ attribution: "identified" }), policy: policyWith([{ principal: "dana@example.test", key: "ssh-ed25519 AAAA" }]) };
    expect(() => refuseUnidentified(source, ["github:alice", "dana@example.test"], "--by")).not.toThrow();
    expect(() => refuseUnidentified(source, ["github:alice", "alex"], "--by")).toThrow(IdentityError);
    // any, or no identity block, keeps every name: hud's roster names still work there.
    expect(() => refuseUnidentified({ ...source, declaration: decl({}) }, ["alex"], "--by")).not.toThrow();
    expect(() => refuseUnidentified({ ...source, declaration: null }, ["alex"], "--by")).not.toThrow();
  });

  test.skipIf(!hasSshKeygen)("records review and points answer refuse a roster name under identified at base", async () => {
    const r = new TestRepo("identity-review");
    repos.push(r);
    const DECISIONS = join(import.meta.dirname, "..", "..", "..", "..", "docs", "design", "decisions");
    r.write("decisions/decision.kind.mjs", readFileSync(join(DECISIONS, "decision.kind.mjs"), "utf-8"));
    r.write("decisions/decision.schema.json", readFileSync(join(DECISIONS, "decision.schema.json"), "utf-8"));
    r.write("decisions/ws-003-seal-scope.md", readFileSync(join(DECISIONS, "ws-003-seal-scope.md"), "utf-8"));
    r.write("chant.workspace.json", JSON.stringify({ name: "acme", schema: 1, members: [], identity: { attribution: "identified" } }));
    r.commit("base");
    r.git(["checkout", "-q", "-b", "change"]);
    const kind = "decisions/decision.kind.mjs";
    const refused = await reviewRecord({ kind, id: "ws-003", verdict: "agree", by: "alex", cwd: r.dir, on: "2026-10-03", dryRun: true });
    expect("error" in refused && refused.error.code).toBe("principal-unidentified");
    const taken = await reviewRecord({ kind, id: "ws-003", verdict: "agree", by: "github:alex", cwd: r.dir, on: "2026-10-03", dryRun: true });
    expect("error" in taken ? taken.error : null).toBeNull();
    const answer = await answerPoint({ id: "P-1", answer: "yes", by: ["alex"], cwd: r.dir });
    expect("error" in answer && answer.error.code).toBe("principal-unidentified");
  });
});

describe.skipIf(!hasSshKeygen)("identity.gates", () => {
  function keys(): { r: TestRepo; alice: Key; bob: Key; mallory: Key } {
    const r = new TestRepo("identity-gates");
    repos.push(r);
    return { r, alice: r.key("alice"), bob: r.key("bob"), mallory: r.key("mallory") };
  }

  const approval = (resolvedBy: string, extra: Partial<GateResolutionRecord> = {}): GateResolutionRecord => ({
    version: 1,
    op: "web",
    gate: "ship",
    environment: "prod",
    planDigest: "sha256:" + "a".repeat(64),
    resolvedBy,
    timestamp: "2026-10-03T12:00:00.000Z",
    ...extra,
  });
  const signed = (key: Key, a: GateResolutionRecord): GateResolutionRecord => ({ ...a, seal: sealGateApproval(key.file, a) });

  test("counts only an approval sealed by a listed signer in the class", () => {
    const { alice, bob, mallory } = keys();
    const policy = policyWith(
      [
        { principal: "github:alice", key: alice.pub },
        { principal: "github:bob", key: bob.pub },
      ],
      { operator: ["github:alice"] },
    );
    const classes = createClassRegistry([{ name: "operator", description: "operators", role: "operator", source: "plugins/ops" }]);
    const rule = gateAdmissionFrom({ declaration: decl({ gates: { ship: { class: "operator" } } }), policy, classes }, "ship")!;
    expect(rule.requirement.class).toBe("operator");
    expect(gateAdmissionFrom({ declaration: decl({ gates: { ship: {} } }), policy, classes }, "rollout")).toBeNull();

    expect(rule.refuses(signed(alice, approval("github:alice")))).toBeNull();
    // A hud roster name or an unsigned forge identity can't clear it.
    expect(rule.refuses(approval("alex"))).toMatch(/not signed/);
    expect(rule.refuses(approval("github:alice"))).toMatch(/not signed/);
    // Signed by a listed signer outside the class.
    expect(rule.refuses(signed(bob, approval("github:bob")))).toMatch(/not in the class operator/);
    // Someone else's key under alice's name.
    expect(rule.refuses(signed(mallory, approval("github:alice")))).toMatch(/does not verify/);
    // A seal over another plan doesn't carry over.
    const moved = { ...signed(alice, approval("github:alice")), planDigest: "sha256:" + "b".repeat(64) };
    expect(rule.refuses(moved)).toMatch(/does not verify/);

    // Any listed signer, when the rule names no class.
    const anySigner = gateAdmissionFrom({ declaration: decl({ gates: { ship: {} } }), policy, classes }, "ship")!;
    expect(anySigner.refuses(signed(bob, approval("github:bob")))).toBeNull();
    // A class no pinned package supplies lets nothing through.
    const unknown = gateAdmissionFrom({ declaration: decl({ gates: { ship: { class: "operator" } } }), policy, classes: coreClassRegistry() }, "ship")!;
    expect(unknown.refuses(signed(alice, approval("github:alice")))).toMatch(/no pinned package supplies/);
  });

  test("a relayed approval: the seal covers relayedBy, and status lists it (#3402)", () => {
    const { alice } = keys();
    const policy = policyWith([{ principal: "github:alice", key: alice.pub }]);
    const rule = gateAdmissionFrom({ declaration: decl({ gates: { ship: {} } }), policy, classes: coreClassRegistry() }, "ship")!;
    const relayed = signed(alice, approval("github:alice", { relayedBy: "github:hud-follower" }));
    expect(rule.refuses(relayed)).toBeNull();
    // The relay can't be changed, dropped or added after sealing.
    expect(rule.refuses({ ...relayed, relayedBy: "github:mallory" })).toMatch(/does not verify/);
    const { relayedBy: _dropped, ...unrelayed } = relayed;
    expect(rule.refuses(unrelayed)).toMatch(/does not verify/);
    expect(rule.refuses({ ...signed(alice, approval("github:alice")), relayedBy: "github:hud-follower" })).toMatch(/does not verify/);
    // A seal made before #3402, with no relay, still verifies.
    expect(rule.refuses(signed(alice, approval("github:alice")))).toBeNull();

    const pending: PendingGateRecord = { version: 1, kind: "pending", op: "web", gate: "ship", environment: "prod", planDigest: "sha256:" + "a".repeat(64), timestamp: "2026-10-03T11:00:00.000Z", expiresAt: "2026-10-10T11:00:00.000Z" };
    const ledger = [pending, relayed, approval("bob")].map((l) => JSON.stringify(l)).join("\n");
    const gate = gatesInLedger("web", ledger, ["prod"], "2026-10-03T13:00:00.000Z").gates[0];
    expect(gate.approvals).toEqual([
      { principal: "github:alice", channel: null, relayedBy: "github:hud-follower", at: "2026-10-03T12:00:00.000Z" },
      { principal: "bob", channel: null, relayedBy: null, at: "2026-10-03T12:00:00.000Z" },
    ]);
  });

  test("a run and workspace status leave out approvals the rule refuses", async () => {
    const { alice } = keys();
    const policy = policyWith([{ principal: "github:alice", key: alice.pub }]);
    const rule = gateAdmissionFrom({ declaration: decl({ gates: { ship: {} } }), policy, classes: coreClassRegistry() }, "ship")!;
    const pending: PendingGateRecord = {
      version: 1,
      kind: "pending",
      op: "web",
      gate: "ship",
      environment: "prod",
      planDigest: "sha256:" + "a".repeat(64),
      timestamp: "2026-10-03T11:00:00.000Z",
      expiresAt: "2026-10-10T11:00:00.000Z",
    };
    const input = { op: "web", gate: "ship", environment: "prod", planDigest: pending.planDigest, now: "2026-10-03T13:00:00.000Z" };

    const roster = memoryGateLedgerPort({ pending: [pending], resolutions: [approval("alex")] });
    expect((await evaluateGate(roster, input)).satisfied).toBe(true);
    expect((await evaluateGate({ ...roster, approvalRule: async () => rule }, input)).satisfied).toBe(false);
    const sealed = memoryGateLedgerPort({ pending: [pending], resolutions: [approval("alex"), signed(alice, approval("github:alice"))] });
    const check = await evaluateGate({ ...sealed, approvalRule: async () => rule }, input);
    expect(check.satisfied && check.resolution.resolvedBy).toBe("github:alice");

    const ledger = [pending, approval("alex")].map((l) => JSON.stringify(l)).join("\n");
    const open = gatesInLedger("web", ledger, ["prod"], "2026-10-03T13:00:00.000Z", (g) => (g === "ship" ? rule : null)).gates[0];
    expect(open.state).toBe("pending");
    expect(open.signed).toEqual({ class: null });
    expect(open.approve).toMatch(/--sign$/);
    const plain = gatesInLedger("web", ledger, ["prod"], "2026-10-03T13:00:00.000Z").gates[0];
    expect(plain.state).toBe("approved");
    expect(plain.signed).toBeNull();
  });
});
