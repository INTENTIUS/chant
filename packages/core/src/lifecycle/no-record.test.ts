/**
 * #3955: a run that records nothing leaves `chant/lifecycle` exactly as it
 * found it, locally and on the remote, while reading its own writes back.
 */
import { afterEach, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listFilesInDir, pushLifecycleStatus, pushRefStatus, readBlobFromPath, writeBlobToPath } from "./git";
import { appendReleaseRecord } from "./release-ledger";
import { GateNotRecordableError, ledgerRecordingOff, noRecordEndNote, resetNoRecordLedger, unrecordedWrites } from "./no-record";
import { runOpLocally } from "../op/local-executor";
import { evaluateGate, gitGateLedgerPort, memoryGateLedgerPort } from "../op/gate";
import { lifecycleReceiptStore } from "../op/lifecycle-receipt-store";
import type { OpConfig } from "../op/types";

const dirs: string[] = [];

afterEach(() => {
  delete process.env.CHANT_NO_RECORD;
  resetNoRecordLedger();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function tmp(name: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `no-record-${name}-`)));
  dirs.push(dir);
  return dir;
}

/** A clone of a bare remote, with a `chant/lifecycle` holding one recorded release and pushed. */
async function recordedCheckout(): Promise<{ dir: string; remote: string }> {
  const remote = tmp("remote");
  git(["init", "-q", "--bare", "-b", "main"], remote);
  const dir = tmp("checkout");
  git(["clone", "-q", remote, dir], tmpdir());
  git(["config", "user.email", "test@chant.dev"], dir);
  git(["config", "user.name", "Test"], dir);
  writeFileSync(join(dir, "README.md"), "fixture\n");
  git(["add", "README.md"], dir);
  git(["commit", "-q", "-m", "init"], dir);
  git(["push", "-q", "origin", "main"], dir);
  await writeBlobToPath("prod", "releases.jsonl", '{"seed":true}\n', "seed", { cwd: dir });
  expect((await pushLifecycleStatus({ cwd: dir })).status).toBe("pushed");
  return { dir, remote };
}

function refs(dir: string, remote: string): { local: string; remote: string } {
  return {
    local: git(["rev-parse", "refs/heads/chant/lifecycle"], dir),
    remote: git(["rev-parse", "refs/heads/chant/lifecycle"], remote),
  };
}

describe("CHANT_NO_RECORD", () => {
  test("is off unless set to something other than empty, 0 or false", () => {
    expect(ledgerRecordingOff({})).toBe(false);
    expect(ledgerRecordingOff({ CHANT_NO_RECORD: "" })).toBe(false);
    expect(ledgerRecordingOff({ CHANT_NO_RECORD: "0" })).toBe(false);
    expect(ledgerRecordingOff({ CHANT_NO_RECORD: "false" })).toBe(false);
    expect(ledgerRecordingOff({ CHANT_NO_RECORD: "1" })).toBe(true);
    expect(ledgerRecordingOff({ CHANT_NO_RECORD: "yes" })).toBe(true);
  });

  test("writes stay in memory and read back, and the ledger ref and the remote are unchanged", async () => {
    const { dir, remote } = await recordedCheckout();
    const before = refs(dir, remote);

    process.env.CHANT_NO_RECORD = "1";
    await writeBlobToPath("prod", "receipts/x.receipt", "sha256:1\n", "Receipt x", { cwd: dir });
    await appendReleaseRecord(
      { component: "api", env: "prod", digest: "sha256:abc", actor: "ci", gitSha: "0".repeat(40), runId: "r1", timestamp: "2026-10-12T00:00:00.000Z" } as never,
      { cwd: dir },
    );

    // The run sees its own writes on top of what was recorded before it.
    expect(await readBlobFromPath("prod", "receipts/x.receipt", { cwd: dir })).toBe("sha256:1\n");
    const releases = (await readBlobFromPath("prod", "releases.jsonl", { cwd: dir }))!;
    expect(releases).toContain('{"seed":true}');
    expect(releases).toContain("sha256:abc");
    expect(await listFilesInDir("prod", { cwd: dir })).toEqual(expect.arrayContaining(["receipts", "releases.jsonl"]));

    // Nothing reaches the branch or the remote, a lease ref included.
    expect(await pushLifecycleStatus({ cwd: dir })).toEqual({ status: "not-recorded" });
    git(["update-ref", "refs/chant/lease/x", git(["rev-parse", "HEAD"], dir)], dir);
    expect(await pushRefStatus("refs/chant/lease/x", { cwd: dir })).toBe("no-remote");
    expect(git(["ls-remote", remote, "refs/chant/lease/x"], dir)).toBe("");
    expect(refs(dir, remote)).toEqual(before);
    expect(unrecordedWrites().map((w) => w.path)).toEqual(["prod/receipts/x.receipt", "prod/releases.jsonl"]);
    expect(noRecordEndNote("--no-record")).toContain("2 ledger writes were dropped (2 files)");

    // Once the run is over, the ledger reads as it was.
    delete process.env.CHANT_NO_RECORD;
    resetNoRecordLedger();
    expect(await readBlobFromPath("prod", "receipts/x.receipt", { cwd: dir })).toBeNull();
    expect(await readBlobFromPath("prod", "releases.jsonl", { cwd: dir })).toBe('{"seed":true}\n');
  });

  test("an Op run records no run, no receipt and no push, and its steps still read their own receipts", async () => {
    const { dir, remote } = await recordedCheckout();
    const before = refs(dir, remote);
    const receipts = lifecycleReceiptStore({ environment: "prod", cwd: dir });
    const ref = { name: "migrate:001", effect: "migrate", flavor: "hash", inputs: {} } as const;
    let readBack: string | undefined;
    const op = {
      name: "migrate",
      overview: "migrate",
      phases: [{ name: "Apply", steps: [{ kind: "activity", fn: "apply", args: {} }, { kind: "activity", fn: "check", args: {} }] }],
    } as unknown as OpConfig;
    const activities = new Map([
      ["apply", async () => { await receipts.write(ref, "sha256:1"); return {}; }],
      ["check", async () => { readBack = await receipts.read(ref); return {}; }],
    ]);

    process.env.CHANT_NO_RECORD = "1";
    const result = await runOpLocally(op, activities as never, {}, undefined, { runId: "r1", ledger: { cwd: dir }, cwd: dir });

    expect(result.status).toBe("ok");
    expect(readBack).toBe("sha256:1");
    expect(refs(dir, remote)).toEqual(before);
    // The run record was written, and dropped with the receipt.
    expect(unrecordedWrites().some((w) => w.path.startsWith("local/runs__migrate"))).toBe(true);
  });

  test("a gate step fails, writes no pending fact, and nothing after it runs but onFailure", async () => {
    const { dir, remote } = await recordedCheckout();
    const before = refs(dir, remote);
    const ran: string[] = [];
    const op = {
      name: "release",
      overview: "release",
      phases: [
        { name: "Plan", steps: [{ kind: "activity", fn: "plan", args: {} }] },
        { name: "Apply", steps: [{ kind: "gate", gate: "approve-prod" }, { kind: "activity", fn: "apply", args: {} }] },
      ],
      onFailure: [{ name: "Undo", steps: [{ kind: "activity", fn: "undo", args: {} }] }],
    } as unknown as OpConfig;
    const activities = new Map([
      ["plan", async () => { ran.push("plan"); return {}; }],
      ["apply", async () => { ran.push("apply"); return {}; }],
      ["undo", async () => { ran.push("undo"); return {}; }],
    ]);

    process.env.CHANT_NO_RECORD = "1";
    let result;
    try {
      result = await runOpLocally(op, activities as never, {}, undefined, { runId: "r1", ledger: { cwd: dir }, cwd: dir, gates: gitGateLedgerPort({ cwd: dir }) });
    } catch (err) {
      result = (err as { result: Awaited<ReturnType<typeof runOpLocally>> }).result;
    }

    expect(result.status).toBe("fail");
    // A failing step like any other: onFailure runs, and nothing after the gate does.
    expect(ran).toEqual(["plan", "undo"]);
    const gate = result.records.find((r) => r.fn.includes("approve-prod"));
    expect(gate).toMatchObject({ status: "fail" });
    expect(gate!.error).toContain('gate "approve-prod" of "release" cannot be passed under --no-record');
    expect(unrecordedWrites().some((w) => w.path.startsWith("_gates/"))).toBe(false);
    expect(refs(dir, remote)).toEqual(before);
  });

  test("a standing approval does not pass the gate", async () => {
    const port = memoryGateLedgerPort({
      resolutions: [{ op: "release", gate: "approve-prod", resolvedBy: "alice", timestamp: "2026-10-12T00:00:00.000Z" } as never],
    });
    expect((await evaluateGate(port, { op: "release", gate: "approve-prod" })).satisfied).toBe(true);
    process.env.CHANT_NO_RECORD = "1";
    await expect(evaluateGate(port, { op: "release", gate: "approve-prod" })).rejects.toBeInstanceOf(GateNotRecordableError);
  });
});
