/**
 * #3192: the agent-run statement. A run's record, signed in a DSSE envelope
 * by a runner or steward key `.chant/trust.json` lists at base, stored as a
 * `statement` line in the run's ledger file, reported by `runs --json` and
 * `runs verify`, and counted by `workspace verify`.
 *
 * - main holds the declaration and a trust policy listing `lobby` (service).
 * - Run A works on W-1 for alice and makes c1 with its Chant-Run trailer;
 *   the lobby's key signs it here with `runs sign --key`.
 * - Run B is signed elsewhere: `runs statement` gives the payload, the
 *   signer signs it, and `runs sign --envelope` checks and stores it.
 * - Run C ends unsigned and makes c3; run D never ends.
 */

import { generateKeyPairSync } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { cleanScratch, contract, git, repo, writeFiles } from "./__fixtures__/contract-repo";
import { runsSign, runStatement, runsVerify, runsWrite, workspaceRuns, type RunsWriteDocument } from "./runs-cli";
import runsSchema from "./runs.schema.json";
import runsWriteSchema from "./runs-write.schema.json";
import runStatementSchema from "./run-statement.schema.json";
import { IN_TOTO_PAYLOAD_TYPE, loadRunnerKey, signEnvelope } from "./trust/dsse";
import { buildRunStatement, signRunStatement, verifyRunStatement } from "./trust/run-statement";
import { verifyChange } from "./trust/verify";

const writeContract = contract(runsWriteSchema);
const readContract = contract(runsSchema);
const statementContract = contract(runStatementSchema);

function runnerKey(): { pem: string; pub: string } {
  const { privateKey } = generateKeyPairSync("ed25519");
  const pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  return { pem, pub: loadRunnerKey(pem).publicKey };
}

let root: string;
const lobby = runnerKey();
const stranger = runnerKey();
const sha: Record<string, string> = {};
const run: Record<string, string> = {};

const trust = (runners: { principal: string; class: string; key: string }[]) => JSON.stringify({ schema: 1, runners });

function commit(message: string[]): string {
  git(root, "add", "-A");
  git(root, "commit", "-q", ...message.flatMap((m) => ["-m", m]));
  return git(root, "rev-parse", "HEAD");
}

async function write(verb: "start" | "end" | "record", fields: object, id?: string): Promise<Exclude<RunsWriteDocument, { error: unknown }>> {
  const doc = await runsWrite({ verb, id, fields: JSON.stringify(fields), cwd: root });
  writeContract.expectValid(doc);
  if ("error" in doc) throw new Error(`${doc.error.code}: ${doc.error.message}`);
  return doc;
}

async function sign(id: string, opts: { keyPem?: string; envelope?: string }): Promise<RunsWriteDocument> {
  const doc = await runsSign({ id, cwd: root, ...opts });
  writeContract.expectValid(doc);
  return doc;
}

beforeAll(async () => {
  root = repo({
    "chant.workspace.json": JSON.stringify({ name: "statements", schema: 1, members: [{ name: "app", dir: "app", kind: "other", because: "the app" }] }),
    ".chant/trust.json": trust([{ principal: "lobby", class: "service", key: lobby.pub }]),
    "app/main.js": "export const n = 0;\n",
  });
  sha.c0 = commit(["the workspace"]);
  git(root, "branch", "-M", "main");

  const a = await write("start", { harness: { name: "claude-code", version: "2.1.0" }, model: "claude-opus-5-5", provider: "anthropic", by: "alice", unit: "W-1", startedAt: "2026-10-01T10:00:00Z" });
  run.a = a.run.id;
  writeFiles(root, { "app/main.js": "export const n = 1;\n" });
  sha.c1 = commit(["one", a.trailer]);
  await write("end", { endedAt: "2026-10-01T10:05:00Z", outcome: "done", cost: { amount: 0.5, currency: "USD", source: "lobby:list-2026-09" } }, run.a);

  writeFiles(root, { "app/main.js": "export const n = 2;\n" });
  sha.c2 = commit(["two, by a person"]);
  run.b = (await write("record", { id: "chat-0001", harness: "hud-chat", model: "claude-sonnet", by: "bob", startedAt: "2026-10-01T11:00:00Z", endedAt: "2026-10-01T11:00:30Z", commits: [sha.c2] })).run.id;

  run.c = (await write("start", { id: "build-c", harness: "claude-code", model: "claude-opus-5-5", by: "carol", unit: "W-2", startedAt: "2026-10-01T12:00:00Z" })).run.id;
  writeFiles(root, { "app/main.js": "export const n = 3;\n" });
  sha.c3 = commit(["three", "Chant-Run: build-c"]);
  await write("end", { endedAt: "2026-10-01T12:05:00Z", outcome: "done" }, run.c);
  run.d = (await write("start", { id: "build-d", harness: "claude-code", by: "alice", startedAt: "2026-10-01T13:00:00Z" })).run.id;
});
afterAll(cleanScratch);

describe("signing a run", () => {
  test("runs sign --key stores a statement over the record, its unit, harness, model and commits", async () => {
    const doc = await sign(run.a, { keyPem: lobby.pem });
    if ("error" in doc) throw new Error(`${doc.error.code}: ${doc.error.message}`);
    expect(doc.verb).toBe("sign");
    expect(doc.statement).toMatchObject({ signer: "lobby", class: "service" });
    expect(doc.run.statements).toHaveLength(1);
    expect(doc.run.attestation).toMatchObject({ status: "signed", signer: "lobby", commits: [sha.c1] });
    const statement = JSON.parse(Buffer.from(doc.statement!.envelope.payload, "base64").toString("utf8"));
    expect(statement.predicateType).toBe("https://intentius.io/chant/agent-run/v1");
    expect(statement.subject).toEqual([{ name: sha.c1, digest: { gitCommit: sha.c1 }, annotations: { patchId: expect.stringMatching(/^[0-9a-f]{40}$/) } }]);
    expect(statement.predicate).toEqual({
      signer: "lobby",
      run: { id: run.a, record: { sha256: doc.run.record!.sha256 } },
      unit: { id: "W-1", kind: null },
      harness: { name: "claude-code", version: "2.1.0" },
      model: "claude-opus-5-5",
      provider: "anthropic",
      by: "alice",
    });
  });

  test("a statement signed elsewhere is printed with runs statement, then checked and stored with runs sign --envelope", async () => {
    const s = await runStatement(run.b, "lobby", root);
    statementContract.expectValid(s);
    if ("error" in s) throw new Error(s.error.message);
    // The signer signs the payload as given, with any DSSE library.
    const { key } = loadRunnerKey(lobby.pem);
    const envelope = signEnvelope(s.payloadType, Buffer.from(s.payload, "base64"), key, lobby.pub);
    expect(s.payloadType).toBe(IN_TOTO_PAYLOAD_TYPE);
    const doc = await sign(run.b, { envelope: JSON.stringify(envelope) });
    if ("error" in doc) throw new Error(`${doc.error.code}: ${doc.error.message}`);
    expect(doc.run.attestation).toMatchObject({ status: "signed", signer: "lobby", commits: [sha.c2] });
  });

  test("refuses a key the policy at base does not list, a run that has not ended, and an envelope that is not the run's", async () => {
    const refused = async (id: string, opts: { keyPem?: string; envelope?: string }) => {
      const doc = await sign(id, opts);
      return "error" in doc ? doc.error.code : "written";
    };
    expect(await refused(run.c, { keyPem: stranger.pem })).toBe("runner-key-unlisted");
    expect(await refused(run.c, { keyPem: "not a key" })).toBe("runner-key-invalid");
    expect(await refused(run.d, { keyPem: lobby.pem })).toBe("run-not-ended");
    expect(await refused("nope", { keyPem: lobby.pem })).toBe("run-unknown");
    expect(await refused(run.c, { envelope: "{" })).toBe("envelope-unreadable");

    const runs = await workspaceRuns({ cwd: root });
    if ("error" in runs) throw new Error(runs.error.message);
    const c = runs.runs.find((r) => r.id === run.c)!;
    const { key } = loadRunnerKey(lobby.pem);
    const strangerKey = loadRunnerKey(stranger.pem);
    // Signed by a key nobody listed.
    expect(await refused(run.c, { envelope: JSON.stringify(signRunStatement(buildRunStatement(c, "lobby"), strangerKey.key, stranger.pub)) })).toBe("envelope-untrusted");
    // The lobby's key, speaking for another signer.
    expect(await refused(run.c, { envelope: JSON.stringify(signRunStatement(buildRunStatement(c, "ci"), key, lobby.pub)) })).toBe("run-statement-signer-mismatch");
    // The lobby's key, saying the run used another model than its record does.
    expect(await refused(run.c, { envelope: JSON.stringify(signRunStatement(buildRunStatement({ ...c, model: "claude-haiku" }, "lobby"), key, lobby.pub)) })).toBe("run-statement-mismatch");
    // Run A's statement, offered for run C.
    const a = runs.runs.find((r) => r.id === run.a)!;
    expect(await refused(run.c, { envelope: JSON.stringify(a.statements[0].envelope) })).toBe("run-statement-mismatch");
    // A DSSE envelope over something other than an agent-run statement.
    expect(await refused(run.c, { envelope: JSON.stringify(signEnvelope(IN_TOTO_PAYLOAD_TYPE, Buffer.from("{}"), key, lobby.pub)) })).toBe("run-statement-invalid");

    const after = await workspaceRuns({ cwd: root });
    if ("error" in after) throw new Error(after.error.message);
    expect(after.runs.find((r) => r.id === run.c)!.statements).toEqual([]);
  });

  test("a record that changed after signing no longer matches its statement", () => {
    return workspaceRuns({ cwd: root }).then((doc) => {
      if ("error" in doc) throw new Error(doc.error.message);
      const a = doc.runs.find((r) => r.id === run.a)!;
      const policyRunners = [{ principal: "lobby", class: "service" as const, key: lobby.pub }];
      expect(verifyRunStatement(a.statements[0].envelope, policyRunners, a).status).toBe("verified");
      const v = verifyRunStatement(a.statements[0].envelope, policyRunners, { ...a, record: { sha256: "0".repeat(64) } });
      expect(v).toMatchObject({ status: "mismatch", code: "run-statement-mismatch", signer: "lobby" });
    });
  });
});

describe("reading statements", () => {
  test("runs --json carries each run's record hash, its statements and their verdict against the keys at base", async () => {
    const doc = await workspaceRuns({ cwd: root });
    readContract.expectValid(doc);
    if ("error" in doc) throw new Error(doc.error.message);
    expect(doc.trust).toMatchObject({ baseFrom: "main", runners: [{ principal: "lobby", class: "service" }], problems: [] });
    const by = Object.fromEntries(doc.runs.map((r) => [r.id, r]));
    expect(by[run.a].attestation).toMatchObject({ status: "signed", signer: "lobby", class: "service", code: null });
    expect(by[run.b].attestation?.status).toBe("signed");
    expect(by[run.c].attestation).toMatchObject({ status: "unsigned", code: null });
    expect(by[run.d].record).toBeNull();
    expect(by[run.d].attestation?.reason).toMatch(/has not ended/);
  });

  test("runs verify reports and never fails on its own; --require signed fails on an ended run that is not signed", async () => {
    const report = await runsVerify({ cwd: root });
    statementContract.expectValid(report);
    if ("error" in report) throw new Error(report.error.message);
    expect(report.ok).toBe(true);
    expect(report.summary).toEqual({ runs: 4, signed: 2, unsigned: 2, failed: 0, running: 1 });

    const required = await runsVerify({ cwd: root, require: "signed" });
    statementContract.expectValid(required);
    if ("error" in required) throw new Error(required.error.message);
    expect(required.ok).toBe(false);
    expect(required.failures).toHaveLength(1);
    expect(required.failures[0]).toMatch(/^build-c is unsigned/);

    const one = await runsVerify({ cwd: root, id: run.a, require: "signed" });
    if ("error" in one) throw new Error(one.error.message);
    expect(one.ok).toBe(true);
    const unknown = await runsVerify({ cwd: root, id: "nope" });
    statementContract.expectValid(unknown);
    expect("error" in unknown && unknown.error.code).toBe("run-unknown");
  });
});

describe("workspace verify counts a commit a signed run made", () => {
  test("--require attested-runs needs a statement for each commit a run made, and nothing of a person's", () => {
    const report = verifyChange({ repo: root, base: sha.c0, head: "HEAD", require: "attested-runs", attestors: [] });
    expect(report.runs.runners).toEqual(["lobby"]);
    expect(report.runs.commits.map((c) => [c.commit, c.runs, c.attested])).toEqual([
      [sha.c1, [run.a], true],
      [sha.c2, [run.b], true],
      [sha.c3, [run.c], false],
    ]);
    expect(report.ok).toBe(false);
    expect(report.failures).toEqual([expect.stringMatching(new RegExp(`^${sha.c3.slice(0, 8)} was made by agent run build-c`))]);

    const upToC2 = verifyChange({ repo: root, base: sha.c0, head: sha.c2, require: "attested-runs", attestors: [] });
    expect(upToC2.ok).toBe(true);
    // Without --require the same report fails nothing (studio-035 d).
    expect(verifyChange({ repo: root, base: sha.c0, head: "HEAD", attestors: [] }).ok).toBe(true);
  });

  test("a runner key removed at base no longer vouches for what it signed", async () => {
    writeFiles(root, { ".chant/trust.json": trust([]) });
    const revoked = commit(["remove the lobby's key"]);
    const doc = await workspaceRuns({ cwd: root });
    if ("error" in doc) throw new Error(doc.error.message);
    expect(doc.runs.find((r) => r.id === run.a)!.attestation).toMatchObject({ status: "untrusted", code: "envelope-untrusted" });
    const report = verifyChange({ repo: root, base: revoked, head: "HEAD", require: "attested-runs", attestors: [] });
    expect(report.runs.runners).toEqual([]);
    // Judged by the policy at the older base, the statement still verifies.
    const older = await workspaceRuns({ cwd: root, base: sha.c0 });
    if ("error" in older) throw new Error(older.error.message);
    expect(older.runs.find((r) => r.id === run.a)!.attestation?.status).toBe("signed");
  });
});
