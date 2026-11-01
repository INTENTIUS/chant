/**
 * #4646: an approval signed outside chant counts toward a gate that counts
 * only signed approvals. `chant approve --statement` prints the bytes, an ssh
 * key on another machine or a passkey signs them, and `chant approve
 * --signature` records the signature, checked against the signers file and
 * the passkeys in `.chant/trust.json` at base. Real keys: ssh-keygen and
 * node:crypto. Against temp repos; nothing is pushed.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendPendingGate, readGateLedger } from "../../lifecycle/gate-ledger";
import { resetGateOrigin } from "../../lifecycle/gate-origin";
import { gateSealPayload } from "../../lifecycle/gate-seal";
import { GATE_BINDING_MAX_BYTES, GATE_STATEMENT_SCHEMA_ID, gateBindingProblem, type GateStatement } from "../../lifecycle/gate-statement";
import { assert, passkey, type Passkey } from "../../lifecycle/test-passkey";
import { gateAdmission } from "../../workspace/identity";
import { checkGateSeal } from "../../workspace/trust/seal";
import { readTrustPolicy } from "../../workspace/trust/policy";
import { gitRevisionSource } from "../../workspace/record-source";
import { hasSshKeygen, TestRepo, type Key } from "../../workspace/trust/test-repo";
import { contract, validSchema } from "../../workspace/__fixtures__/contract-repo";
import { gateApprovalStatement, recordGateApproval, runApprove } from "./approve";
import { parseArgs } from "../main";
import type { ParsedArgs } from "../registry";
import schema from "../../gate-statement.schema.json";

vi.mock("../../op/discover", () => ({ discoverOps: async () => ({ errors: [], ops: new Map() }) }));

const PLAN = `sha256:${"a".repeat(64)}`;
const OTHER = `sha256:${"b".repeat(64)}`;
const PENDING_AT = "2026-01-01T09:00:00.000Z";

const repos: TestRepo[] = [];
const home = process.cwd();
afterEach(() => {
  process.chdir(home);
  resetGateOrigin();
  while (repos.length) repos.pop()!.cleanup();
});

let keys: TestRepo;
let alice: Key;
let mallory: Key;
let erin: Passkey;
let frank: Passkey;
beforeAll(() => {
  erin = passkey("github:erin", "cred-erin", "EdDSA");
  frank = passkey("github:frank", "cred-frank", "ES256");
  if (!hasSshKeygen) return;
  keys = new TestRepo("4646-keys");
  alice = keys.key("alice");
  mallory = keys.key("mallory");
});
afterAll(() => keys?.cleanup());

/** A workspace whose gate `ship` counts only signed approvals, with alice's ssh key and two passkeys at base, waiting at the gate for PLAN. */
async function waiting(): Promise<TestRepo> {
  const r = new TestRepo("4646");
  repos.push(r);
  r.git(["config", "user.email", "t@example.test"]);
  r.git(["config", "user.name", "t"]);
  r.git(["config", "commit.gpgsign", "false"]);
  r.write("chant.workspace.json", JSON.stringify({ name: "acme", schema: 1, members: [], identity: { gates: { ship: {} } } }));
  r.write(".chant/allowed_signers", `github:alice ${alice.pub}\n`);
  r.write(".chant/trust.json", JSON.stringify({ schema: 1, passkeys: [erin.signer, frank.signer] }));
  r.commit("base");
  await appendPendingGate(
    { op: "deploy", gate: "ship", timestamp: PENDING_AT, origin: "cli", expiresAt: "2999-01-01T00:00:00.000Z", planDigest: PLAN, environment: "prod" },
    { cwd: r.dir },
  );
  process.chdir(r.dir);
  return r;
}

async function statementFor(r: TestRepo, actor: string, extra: { plan?: string; binding?: string } = {}): Promise<GateStatement> {
  const s = await gateApprovalStatement("deploy", "ship", { origin: "cli", actor, cwd: r.dir, ...extra });
  expect(s).not.toBeNull();
  return s!;
}

function file(r: TestRepo, name: string, text: string): string {
  const f = join(r.dir, "..", `${name}-${Math.random().toString(36).slice(2)}`);
  writeFileSync(f, text);
  return f;
}

const { expectValid } = contract(schema);

describe.skipIf(!hasSshKeygen)("an approval signed outside chant (#4646)", () => {
  test("--statement prints the bytes --sign would sign, and records nothing", async () => {
    expect(validSchema(schema)).toBe(true);
    expect(schema.$id).toBe(GATE_STATEMENT_SCHEMA_ID);
    const r = await waiting();
    const s = await statementFor(r, "github:erin");
    expectValid(s);
    const bytes = gateSealPayload({ op: "deploy", gate: "ship", environment: "prod", planDigest: PLAN, resolvedBy: "github:erin", timestamp: s.timestamp });
    expect(Buffer.from(s.statement, "base64")).toEqual(bytes);
    expect(s.text).toBe(`deploy\nship\nprod\n${PLAN}\ngithub:erin\n${s.timestamp}`);
    expect(s).toMatchObject({ planDigest: PLAN, environment: "prod", relayedBy: null, binding: null, sealVersion: 1, namespace: "chant-gate" });
    expect((await readGateLedger("deploy", { cwd: r.dir })).resolutions).toEqual([]);
  });

  test("an ssh signature made on another machine by a wrong key, over another plan or at another time is refused", async () => {
    const r = await waiting();
    const s = await statementFor(r, "github:alice");
    const signed = keys.sshSign(alice, Buffer.from(s.statement, "base64"), s.namespace);

    // mallory's key, and alice's key over the statement for another plan.
    const bad = keys.sshSign(mallory, Buffer.from(s.statement, "base64"), s.namespace);
    expect((await recordGateApproval("deploy", "ship", { origin: "cli", actor: "github:alice", at: s.timestamp, signature: file(r, "bad", bad), cwd: r.dir })).ok).toBe(false);
    const other = await statementFor(r, "github:alice", { plan: OTHER });
    const elsewhere = keys.sshSign(alice, Buffer.from(other.statement, "base64"), s.namespace);
    expect((await recordGateApproval("deploy", "ship", { origin: "cli", actor: "github:alice", at: other.timestamp, signature: file(r, "other", elsewhere), cwd: r.dir })).ok).toBe(false);
    // The right signature at another time.
    const later = new Date(Date.parse(s.timestamp) + 1).toISOString();
    expect((await recordGateApproval("deploy", "ship", { origin: "cli", actor: "github:alice", at: later, signature: file(r, "late", signed), cwd: r.dir })).ok).toBe(false);
    expect((await readGateLedger("deploy", { cwd: r.dir })).resolutions).toEqual([]);
  });

  test("an ssh signature made on another machine counts, and the record re-checks offline", async () => {
    const r = await waiting();
    const s = await statementFor(r, "github:alice");
    const signed = keys.sshSign(alice, Buffer.from(s.statement, "base64"), s.namespace);
    const out = await recordGateApproval("deploy", "ship", { origin: "cli", actor: "github:alice", at: s.timestamp, signature: file(r, "sig", signed), cwd: r.dir });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.record.timestamp).toBe(s.timestamp);
    expect(out.record.seal).toMatchObject({ signer: "github:alice", signature: signed });
    expect(out.record.seal?.key).toMatch(/^SHA256:/);
    expect(out.record.seal?.kind).toBeUndefined();
    expect(gateAdmission(r.dir, "ship")!.refuses(out.record)).toBeNull();
    expect(checkGateSeal(readTrustPolicy(gitRevisionSource(r.dir, "HEAD"), null), out.record).attested).toBe(true);
  });

  test.each([["an Ed25519", () => erin], ["a P-256", () => frank]] as const)("%s passkey's assertion counts, and the record re-checks offline", async (_name, who) => {
    const pk = who();
    const r = await waiting();
    const s = await statementFor(r, pk.signer.principal);
    const a = assert(pk, Buffer.from(s.statement, "base64"));
    const out = await recordGateApproval("deploy", "ship", { origin: "cli", actor: pk.signer.principal, at: s.timestamp, signature: file(r, "assertion", JSON.stringify(a)), cwd: r.dir });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.record.seal).toEqual({
      kind: "webauthn",
      signer: pk.signer.principal,
      key: pk.signer.id,
      signature: a.signature,
      clientDataJSON: a.clientDataJSON,
      authenticatorData: a.authenticatorData,
    });
    // Read back off the ledger and judged again, as a run and verify judge it.
    const [line] = (await readGateLedger("deploy", { cwd: r.dir })).resolutions;
    expect(gateAdmission(r.dir, "ship")!.refuses(line!)).toBeNull();
    const policy = readTrustPolicy(gitRevisionSource(r.dir, "HEAD"), null);
    expect(checkGateSeal(policy, line!)).toMatchObject({ attested: true, key: pk.signer.id });
    // Moving the approval to another plan breaks it.
    expect(checkGateSeal(policy, { ...line!, planDigest: OTHER }).attested).toBe(false);
    expect(gateAdmission(r.dir, "ship")!.refuses({ ...line!, planDigest: OTHER })).toMatch(/challenge/);
  });

  test("a passkey's assertion is refused for another approver, another plan, or without user verification", async () => {
    const r = await waiting();
    const s = await statementFor(r, "github:erin");
    const bytes = Buffer.from(s.statement, "base64");
    const refused = async (actor: string, assertion: object, at = s.timestamp) =>
      !(await recordGateApproval("deploy", "ship", { origin: "cli", actor, at, signature: file(r, "a", JSON.stringify(assertion)), cwd: r.dir })).ok;
    // frank's passkey over erin's statement, recorded as erin: the credential isn't erin's.
    expect(await refused("github:erin", assert(frank, bytes))).toBe(true);
    // erin's passkey recorded as frank: the statement names erin.
    expect(await refused("github:frank", assert(erin, bytes))).toBe(true);
    const other = await statementFor(r, "github:erin", { plan: OTHER });
    expect(await refused("github:erin", assert(erin, Buffer.from(other.statement, "base64")))).toBe(true);
    expect(await refused("github:erin", assert(erin, bytes, { flags: 0x01 }))).toBe(true);
    expect(await refused("github:erin", assert(erin, bytes, { origin: "https://evil.example" }))).toBe(true);
    expect((await readGateLedger("deploy", { cwd: r.dir })).resolutions).toEqual([]);
  });

  test("--at must be the statement's, in chant's form, not before the pending fact or in the future", async () => {
    const r = await waiting();
    const s = await statementFor(r, "github:erin");
    const a = file(r, "a", JSON.stringify(assert(erin, Buffer.from(s.statement, "base64"))));
    const tryAt = async (at: string | undefined) =>
      (await recordGateApproval("deploy", "ship", { origin: "cli", actor: "github:erin", ...(at !== undefined ? { at } : {}), signature: a, cwd: r.dir })).ok;
    expect(await tryAt(undefined)).toBe(false);
    expect(await tryAt("2026-11-01T10:00:00Z")).toBe(false);
    expect(await tryAt("2026-01-01T08:00:00.000Z")).toBe(false);
    expect(await tryAt(new Date(Date.now() + 60 * 60 * 1000).toISOString())).toBe(false);
    expect(await gateApprovalStatement("deploy", "ship", { origin: "cli", actor: "github:erin", at: "2026-01-01T08:00:00.000Z", cwd: r.dir })).toBeNull();
    expect(await tryAt(s.timestamp)).toBe(true);
  });

  test("--at goes with --statement or --signature, and --signature not with --sign", async () => {
    const r = await waiting();
    const s = await statementFor(r, "github:erin");
    const a = file(r, "a", JSON.stringify(assert(erin, Buffer.from(s.statement, "base64"))));
    expect((await recordGateApproval("deploy", "ship", { origin: "cli", actor: "github:erin", at: s.timestamp, cwd: r.dir })).ok).toBe(false);
    expect((await recordGateApproval("deploy", "ship", { origin: "cli", actor: "github:alice", at: s.timestamp, sign: alice.file, signature: a, cwd: r.dir })).ok).toBe(false);
    expect((await readGateLedger("deploy", { cwd: r.dir })).resolutions).toEqual([]);
  });

  test("chant approve --statement prints the document, and --signature - reads stdin's path through the flags", async () => {
    expect(parseArgs(["approve", "deploy", "ship", "--statement", "--actor", "github:erin"])).toMatchObject({ statement: true, actor: "github:erin" });
    expect(parseArgs(["approve", "deploy", "ship", "--signature", "-", "--at", "2026-11-01T10:00:00.000Z"])).toMatchObject({ signature: "-", at: "2026-11-01T10:00:00.000Z" });
    expect(() => parseArgs(["approve", "deploy", "ship", "--signature", "--at", "x"])).toThrow(/--signature needs a file/);
    await waiting();
    const printed: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((t: string) => void printed.push(t));
    try {
      const args = { command: "approve", path: "deploy", extraPositional: "ship", format: "", fix: false, watch: false, verbose: false, help: false, live: false, yes: true, statement: true, actor: "github:erin" } as ParsedArgs;
      expect(await runApprove({ args, plugins: [], serializers: [] } as never)).toBe(0);
      expect(await runApprove({ args: { ...args, signature: "x" }, plugins: [], serializers: [] } as never)).toBe(1);
    } finally {
      log.mockRestore();
    }
    const doc = JSON.parse(printed.join(""));
    expectValid(doc);
    expect(doc).toMatchObject({ schema: "chant-gate-statement/v1", resolvedBy: "github:erin", planDigest: PLAN });
  });

  test("an unsigned approval of the gate is still refused", async () => {
    const r = await waiting();
    expect((await recordGateApproval("deploy", "ship", { origin: "cli", actor: "github:erin", cwd: r.dir })).ok).toBe(false);
  });
});

// #4697: the relay adds a line of its own that the person's signature covers.
const BINDING = "deploy dep_42 until 2026-11-01T12:00:00Z";

describe.skipIf(!hasSshKeygen)("a relay's binding line in the statement (#4697)", () => {
  test("--binding ends the statement with a binding line, seal version 3", async () => {
    const r = await waiting();
    const s = await statementFor(r, "github:erin", { binding: BINDING });
    expectValid(s);
    expect(s.text).toBe(`deploy\nship\nprod\n${PLAN}\ngithub:erin\n${s.timestamp}\nbinding ${BINDING}`);
    expect(s).toMatchObject({ binding: BINDING, sealVersion: 3 });
    expect(Buffer.from(s.statement, "base64")).toEqual(
      gateSealPayload({ op: "deploy", gate: "ship", environment: "prod", planDigest: PLAN, resolvedBy: "github:erin", timestamp: s.timestamp, binding: BINDING }),
    );
    expect((await readGateLedger("deploy", { cwd: r.dir })).resolutions).toEqual([]);
  });

  test("a passkey's assertion over it records the binding, and the record re-checks offline", async () => {
    const r = await waiting();
    const s = await statementFor(r, "github:erin", { binding: BINDING });
    const a = file(r, "a", JSON.stringify(assert(erin, Buffer.from(s.statement, "base64"))));
    const out = await recordGateApproval("deploy", "ship", { origin: "cli", actor: "github:erin", at: s.timestamp, binding: BINDING, signature: a, cwd: r.dir });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.record.binding).toBe(BINDING);
    expect(out.record.seal).toMatchObject({ kind: "webauthn", version: 3 });
    const [line] = (await readGateLedger("deploy", { cwd: r.dir })).resolutions;
    expect(line!.binding).toBe(BINDING);
    expect(gateAdmission(r.dir, "ship")!.refuses(line!)).toBeNull();
    const policy = readTrustPolicy(gitRevisionSource(r.dir, "HEAD"), null);
    expect(checkGateSeal(policy, line!).attested).toBe(true);
    // Another binding, or none, and the line no longer verifies.
    for (const edited of [{ binding: "deploy dep_43 until 2026-11-01T12:00:00Z" }, { binding: undefined }]) {
      expect(checkGateSeal(policy, { ...line!, ...edited }).attested).toBe(false);
      expect(gateAdmission(r.dir, "ship")!.refuses({ ...line!, ...edited })).not.toBeNull();
    }
  });

  test("an ssh signature over it records the binding, and --sign signs one the same way", async () => {
    const r = await waiting();
    const s = await statementFor(r, "github:alice", { binding: BINDING });
    const signed = keys.sshSign(alice, Buffer.from(s.statement, "base64"), s.namespace);
    const out = await recordGateApproval("deploy", "ship", { origin: "cli", actor: "github:alice", at: s.timestamp, binding: BINDING, signature: file(r, "sig", signed), cwd: r.dir });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.record).toMatchObject({ binding: BINDING, seal: { signer: "github:alice", signature: signed, version: 3 } });
    expect(gateAdmission(r.dir, "ship")!.refuses(out.record)).toBeNull();

    const here = await recordGateApproval("deploy", "ship", { origin: "cli", actor: "github:alice", binding: BINDING, sign: alice.file, cwd: r.dir });
    expect(here.ok).toBe(true);
    if (!here.ok) return;
    expect(here.record.seal?.version).toBe(3);
    expect(gateAdmission(r.dir, "ship")!.refuses(here.record)).toBeNull();
    expect(checkGateSeal(readTrustPolicy(gitRevisionSource(r.dir, "HEAD"), null), here.record).attested).toBe(true);
  });

  test("a signature recorded with another binding, or none, than it was made over is refused", async () => {
    const r = await waiting();
    const s = await statementFor(r, "github:erin", { binding: BINDING });
    const a = file(r, "a", JSON.stringify(assert(erin, Buffer.from(s.statement, "base64"))));
    const record = (binding?: string) =>
      recordGateApproval("deploy", "ship", { origin: "cli", actor: "github:erin", at: s.timestamp, ...(binding !== undefined ? { binding } : {}), signature: a, cwd: r.dir });
    expect((await record()).ok).toBe(false);
    expect((await record("deploy dep_43 until 2026-11-01T12:00:00Z")).ok).toBe(false);
    // A signature over a statement with no binding can't be recorded with one.
    const plain = await statementFor(r, "github:erin");
    const b = file(r, "b", JSON.stringify(assert(erin, Buffer.from(plain.statement, "base64"))));
    expect((await recordGateApproval("deploy", "ship", { origin: "cli", actor: "github:erin", at: plain.timestamp, binding: BINDING, signature: b, cwd: r.dir })).ok).toBe(false);
    expect((await readGateLedger("deploy", { cwd: r.dir })).resolutions).toEqual([]);
    // An approval without a binding records as before: no binding, seal version 1.
    const out = await recordGateApproval("deploy", "ship", { origin: "cli", actor: "github:erin", at: plain.timestamp, signature: b, cwd: r.dir });
    expect(out.ok && out.record.binding === undefined && out.record.seal?.version === undefined).toBe(true);
  });

  test("a binding must be one printable line within the limit, and goes with a signature", async () => {
    for (const bad of ["", "two\nlines", "cr\r", "tab\there", "nul\u0000", "bidi \u202e", "sep\u2028", " leading", "trailing ", "x".repeat(GATE_BINDING_MAX_BYTES + 1), "é".repeat(GATE_BINDING_MAX_BYTES / 2 + 1)]) {
      expect(gateBindingProblem(bad), JSON.stringify(bad)).not.toBeNull();
    }
    for (const good of [BINDING, "x".repeat(GATE_BINDING_MAX_BYTES), "déploiement 42 jusqu'à midi", "{\"deploy\":\"dep_42\",\"exp\":1793534400}"]) {
      expect(gateBindingProblem(good), good).toBeNull();
    }
    const r = await waiting();
    expect(await gateApprovalStatement("deploy", "ship", { origin: "cli", actor: "github:erin", binding: "two\nlines", cwd: r.dir })).toBeNull();
    // An unsigned approval has nothing to bind it.
    expect((await recordGateApproval("deploy", "ship", { origin: "cli", actor: "github:erin", binding: BINDING, cwd: r.dir })).ok).toBe(false);
    expect(parseArgs(["approve", "deploy", "ship", "--statement", "--binding", BINDING])).toMatchObject({ statement: true, binding: BINDING });
    expect(() => parseArgs(["approve", "deploy", "ship", "--statement", "--binding", "--at", "x"])).toThrow(/--binding needs/);
  });

  test("a ledger line whose binding isn't one line of text is malformed", async () => {
    const r = await waiting();
    const s = await statementFor(r, "github:erin", { binding: BINDING });
    const a = file(r, "a", JSON.stringify(assert(erin, Buffer.from(s.statement, "base64"))));
    expect((await recordGateApproval("deploy", "ship", { origin: "cli", actor: "github:erin", at: s.timestamp, binding: BINDING, signature: a, cwd: r.dir })).ok).toBe(true);
    const { appendGateResolution } = await import("../../lifecycle/gate-ledger");
    await appendGateResolution({ op: "deploy", gate: "ship", resolvedBy: "github:erin", timestamp: new Date().toISOString(), binding: "a\nb" }, { cwd: r.dir });
    await appendGateResolution({ op: "deploy", gate: "ship", resolvedBy: "github:erin", timestamp: new Date().toISOString(), binding: 7 as unknown as string }, { cwd: r.dir });
    const ledger = await readGateLedger("deploy", { cwd: r.dir });
    expect(ledger.resolutions.map((l) => l.binding)).toEqual([BINDING]);
    expect(ledger.malformed).toBe(2);
  });
});
