/**
 * #5354: `chant reject` records a rejection the way `chant approve` records
 * an approval: the digest, environment and release off the gate's pending
 * fact, the actor, a seal, and the workspace's `identity.gates` rule judged
 * before anything is written.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { memoryGateLedgerPort } from "../../op/gate";
import { gateRejections } from "../../op/gate-reject";
import { GATE_REJECTION_NAMESPACE, gateRejectionPayload } from "../../lifecycle/gate-rejection";
import type { PendingGateRecord } from "../../lifecycle/gate-ledger";
import type { GateSigners } from "../../lifecycle/gate-seal";
import { emptyPolicy, parseAllowedSigners, type TrustPolicy } from "../../workspace/trust/policy";
import { hasSshKeygen } from "../../workspace/trust/test-repo";
import type { GateAdmission } from "../../workspace/identity";
import { admitRejecter } from "../../workspace/identity-reject-rule";
import { recordGateRejection, type GateRejectionOptions } from "./reject";

const RELEASE = "sha256:" + "7".repeat(64);
const pending: PendingGateRecord = {
  version: 1,
  kind: "pending",
  op: "shop",
  gate: "staging",
  timestamp: "2026-11-20T00:00:00.000Z",
  expiresAt: "2099-01-01T00:00:00.000Z",
  planDigest: RELEASE,
  environment: "staging",
  gitSha: "a".repeat(40),
};

const scope = (policy: TrustPolicy = emptyPolicy(null), rule: GateAdmission | null = null): NonNullable<GateRejectionOptions["scope"]> => ({ declaration: null, policy, rule, signers: policy });

describe("chant reject", () => {
  test("takes the digest and the environment off the gate's pending fact, and appends the rejection", async () => {
    const port = memoryGateLedgerPort({ pending: [pending] });
    const out = await recordGateRejection("shop", "staging", { reason: "the migration locks the orders table", actor: "alice", port, scope: scope() });
    expect(out).toMatchObject({ ok: true, record: { kind: "rejection", op: "shop", gate: "staging", rejectedBy: "alice", planDigest: RELEASE, environment: "staging", gitSha: pending.gitSha, approver: { kind: "human" } } });
    expect(port.rejections).toHaveLength(1);
  });

  test("refuses without a reason, with a reason on two lines, and with nothing to reject", async () => {
    const port = memoryGateLedgerPort();
    await expect(recordGateRejection("shop", "staging", { actor: "alice", port, scope: scope() })).resolves.toMatchObject({ ok: false, message: expect.stringContaining("a rejection says why") });
    await expect(recordGateRejection("shop", "staging", { reason: "a\nb", actor: "alice", port, scope: scope() })).resolves.toMatchObject({ ok: false, message: expect.stringContaining("one line") });
    await expect(recordGateRejection("shop", "staging", { reason: "no", actor: "alice", port, scope: scope() })).resolves.toMatchObject({ ok: false, message: expect.stringContaining("no pending fact") });
    expect(port.rejections).toEqual([]);
  });

  test("--plan and --release name a release no pending fact names yet", async () => {
    const port = memoryGateLedgerPort();
    const out = await recordGateRejection("shop", "staging", { reason: "not this one", actor: "alice", plan: RELEASE, environment: "staging", release: RELEASE, port, scope: scope() });
    expect(out).toMatchObject({ ok: true, record: { planDigest: RELEASE, environment: "staging", releaseDigest: RELEASE } });
  });

  test("an agent's rejection is recorded as an agent's", async () => {
    const port = memoryGateLedgerPort({ pending: [pending] });
    const out = await recordGateRejection("shop", "staging", { reason: "no", actor: "bot", agent: true, port, scope: scope() });
    expect(out).toMatchObject({ ok: true, record: { approver: { kind: "agent" } } });
  });

  test("--statement prints the bytes, in the rejection namespace, and records nothing", async () => {
    const port = memoryGateLedgerPort({ pending: [pending] });
    const out = await recordGateRejection("shop", "staging", { reason: "no", actor: "alice", port, scope: scope() }, true);
    expect(out).toMatchObject({ statement: { namespace: GATE_REJECTION_NAMESPACE } });
    if ("statement" in out) expect(out.statement.text.split("\n")[0]).toBe("chant-reject");
    expect(port.rejections).toEqual([]);
  });
});

const dir = mkdtempSync(join(tmpdir(), "chant-5354-reject-cli-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe.skipIf(!hasSshKeygen)("a gate identity.gates names", () => {
  const file = join(dir, "alice");
  if (hasSshKeygen) execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "alice", "-f", file]);
  const pub = hasSshKeygen ? readFileSync(`${file}.pub`, "utf-8").trim().split(" ").slice(0, 2).join(" ") : "";
  const policy = (): TrustPolicy => ({ ...emptyPolicy("0".repeat(40)), active: true, signers: parseAllowedSigners(`alice ${pub}\n`).signers });
  const rule = (): GateAdmission => {
    const p = policy();
    const data = { gate: "staging", class: null, signers: p, roles: {}, classes: [] };
    return { requirement: { class: null } as never, refuses: () => null, refusesRejection: (r) => admitRejecter(data, r) };
  };

  test("refuses an unsigned rejection before writing it", async () => {
    const port = memoryGateLedgerPort({ pending: [pending] });
    const out = await recordGateRejection("shop", "staging", { reason: "no", actor: "alice", port, scope: scope(policy(), rule()) });
    expect(out).toMatchObject({ ok: false, message: expect.stringContaining("only a signed rejection counts there") });
    expect(port.rejections).toEqual([]);
  });

  test("records a rejection signed elsewhere over the statement, which then stops a sealed gate", async () => {
    const port = memoryGateLedgerPort({ pending: [pending] });
    const opts: GateRejectionOptions = { reason: "no", actor: "alice", port, scope: scope(policy(), rule()), at: "2026-11-20T00:10:00.000Z" };
    const st = await recordGateRejection("shop", "staging", opts, true);
    if (!("statement" in st)) throw new Error("no statement");
    const payload = join(dir, "payload");
    writeFileSync(payload, gateRejectionPayload(st.statement.rejection));
    execFileSync("ssh-keygen", ["-q", "-Y", "sign", "-n", GATE_REJECTION_NAMESPACE, "-f", file, payload], { stdio: "ignore" });
    const out = await recordGateRejection("shop", "staging", { ...opts, signature: `${payload}.sig`, cwd: dir });
    expect(out).toMatchObject({ ok: true, record: { seal: { signer: "alice" } } });
    const found = gateRejections(port.rejections, { gate: "staging", planDigest: RELEASE, environment: "staging", mode: "sealed", signers: policy() as GateSigners, roles: {}, identity: rule().refusesRejection });
    expect(found.standing).toHaveLength(1);
  });
});
