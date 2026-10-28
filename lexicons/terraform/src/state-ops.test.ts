/**
 * #4618: the state operations run fixed argument lists on an injected exec,
 * and the gated ones ask, spend and finish on an injected ledger, so no
 * binary runs and no ledger is written.
 */
import { describe, expect, test } from "vitest";
import type { GatedRequest } from "@intentius/chant/lifecycle/gated-request";
import type { BinaryExec } from "./state/exec";
import {
  applyPlanFile,
  attachmentDigest,
  forceUnlockState,
  gatedStateOp,
  planCopy,
  planStateCheck,
  pushStateFile,
  requestedAt,
  StateOpError,
  STATE_OPS,
  type GatedRequestLedger,
} from "./state-ops";

const PLAN = { resource_changes: [{ address: "aws_s3_bucket.logs", mode: "managed", change: { actions: ["create"], before: null } }] };

function recorder(fail?: string): { exec: BinaryExec; calls: string[][] } {
  const calls: string[][] = [];
  const exec: BinaryExec = async (_binary, args) => {
    calls.push(args);
    if (fail && args[0] === fail) return { code: 1, stdout: "", out: "Error: it broke" };
    if (args[0] === "show") return { code: 0, stdout: JSON.stringify(PLAN), out: "" };
    if (args[0] === "plan") return { code: 0, stdout: "", out: "Plan: 1 to add, 0 to change, 0 to destroy." };
    return { code: 0, stdout: "", out: "" };
  };
  return { exec, calls };
}

const root = (exec: BinaryExec) => ({ root: "net", binary: "terraform", dir: "/repo/net", env: {}, exec });

describe("binary runs", () => {
  test("force-unlock takes the lock ID and nothing else", async () => {
    const { exec, calls } = recorder();
    await forceUnlockState({ ...root(exec), id: "a1b2" });
    expect(calls).toEqual([["force-unlock", "-force", "-no-color", "a1b2"]]);
    await expect(forceUnlockState({ ...root(exec), id: "-help" })).rejects.toThrow(/not a lock ID/);
  });

  test("a failed run throws with the binary's last lines", async () => {
    const { exec } = recorder("force-unlock");
    await expect(forceUnlockState({ ...root(exec), id: "a1b2" })).rejects.toBeInstanceOf(StateOpError);
  });

  test("state push passes -lock=false and -force only when asked", async () => {
    const { exec, calls } = recorder();
    await pushStateFile({ ...root(exec), file: "/w/net.tfstate" });
    await pushStateFile({ ...root(exec), file: "/w/net.tfstate", lock: false });
    await pushStateFile({ ...root(exec), file: "/w/net.tfstate", force: true });
    expect(calls).toEqual([
      ["state", "push", "/w/net.tfstate"],
      ["state", "push", "-lock=false", "/w/net.tfstate"],
      ["state", "push", "-force", "/w/net.tfstate"],
    ]);
  });

  test("a migration's check plans with -lock=false while the caller holds the lock, and reads the plan", async () => {
    const { exec, calls } = recorder();
    const read = await planStateCheck({ ...root(exec), planFile: "/w/0.tfplan", lock: false });
    expect(calls[0]).toEqual(["plan", "-input=false", "-no-color", "-lock=false", "-out=/w/0.tfplan"]);
    expect(read.json).toEqual(PLAN);
    expect(read.summary).toBe("Plan: 1 to add, 0 to change, 0 to destroy.");
  });

  test("a copy inits under its own key, plans a destroy with the lock wait, and applies only the saved plan", async () => {
    const { exec, calls } = recorder();
    const read = await planCopy({ ...root(exec), backendConfig: { key: "net/terraform.tfstate-pr-7" }, planFile: "/w/0.tfplan", destroy: true });
    expect(calls[0]).toEqual(["init", "-input=false", "-no-color", "-reconfigure", "-backend-config=key=net/terraform.tfstate-pr-7"]);
    expect(calls[1]).toEqual(["plan", "-input=false", "-no-color", "-lock-timeout=5m", "-destroy", "-out=/w/0.tfplan"]);
    expect(read.part.member.member).toBe("net");
    expect(read.planDigest).not.toBe("");
    await applyPlanFile({ ...root(exec), planFile: "/w/0.tfplan", lockTimeout: false });
    expect(calls.at(-1)).toEqual(["apply", "-input=false", "-no-color", "/w/0.tfplan"]);
  });

  test("a copy with no backend settings of its own is refused before anything runs", async () => {
    const { exec, calls } = recorder();
    await expect(planCopy({ ...root(exec), backendConfig: {}, planFile: "/w/0.tfplan" })).rejects.toThrow(/its own state/);
    expect(calls).toEqual([]);
  });
});

/** A ledger in memory: requests wait until `approve` is called. */
function fakeLedger(): GatedRequestLedger & { approve(by: string): void; writes: string[] } {
  let approvedBy: string | undefined;
  const writes: string[] = [];
  const asked: GatedRequest[] = [];
  let spent = false;
  return {
    writes,
    approve(by: string) {
      approvedBy = by;
    },
    async requestGate(input) {
      asked.push(input.request);
      const digest = `sha256:${input.request.subject}-${input.request.at}`;
      if (spent) return { status: "spent", digest, request: input.request };
      if (!approvedBy) {
        writes.push("pending");
        return { status: "waiting", digest, request: input.request, command: `chant approve ${input.op} ${input.request.subject} --plan ${digest}` };
      }
      return { status: "approved", digest, request: input.request, approval: { version: 1, kind: "resolution", op: input.op, gate: input.request.subject, resolvedBy: approvedBy, timestamp: "2026-10-27T10:00:00Z" } as never };
    },
    async spendGatedRequest(input) {
      spent = true;
      writes.push("applied");
      return { version: 1, kind: "applied", op: input.op, gate: input.gate, planDigest: input.digest, approvedAt: "", approvedBy: "", timestamp: "2026-10-27T11:00:00Z" } as never;
    },
    async finishGatedRequest(input) {
      writes.push(`finished:${input.result}:${JSON.stringify(input.detail ?? {})}`);
      return { record: {} as never, pushed: true };
    },
    async readGatedRequests() {
      return asked.map((request) => ({ op: STATE_OPS.unlock, gate: request.subject, digest: "", request, pending: { expiresAt: "2099-01-01T00:00:00Z" } as never, approvals: [] }));
    },
  };
}

describe("gatedStateOp", () => {
  const input = (ledger: GatedRequestLedger, now: string) => ({ op: STATE_OPS.unlock, request: { kind: "unlock", subject: "net", by: "ana", fields: { id: "a1b2", location: "s3://b/net.tflock" } }, rules: { mode: "ledger" as const }, ledger, now });

  test("waits, then acts once under the approval, with the same request time as the first ask", async () => {
    const ledger = fakeLedger();
    let acted = 0;
    const act = async () => {
      acted++;
      return { output: "released", detail: { lock: "a1b2" } };
    };
    const first = await gatedStateOp(input(ledger, "2026-10-27T09:00:00Z"), act);
    expect(first.status).toBe("waiting");
    ledger.approve("bo");
    const second = await gatedStateOp(input(ledger, "2026-10-27T12:00:00Z"), act);
    expect(second.status).toBe("done");
    expect(second.request.at).toBe("2026-10-27T09:00:00Z");
    expect(acted).toBe(1);
    expect(ledger.writes).toEqual(["pending", "applied", 'finished:applied:{"lock":"a1b2"}']);
    const third = await gatedStateOp(input(ledger, "2026-10-27T13:00:00Z"), act);
    expect(third.status).toBe("spent");
    expect(acted).toBe(1);
  });

  test("a last check that refuses leaves the approval unspent", async () => {
    const ledger = fakeLedger();
    ledger.approve("bo");
    const held = await gatedStateOp({ ...input(ledger, "2026-10-27T09:00:00Z"), beforeSpend: async () => "a run that may hold the lock is alive" }, async () => ({ output: 1 }));
    expect(held.status).toBe("held");
    expect(ledger.writes).toEqual([]);
  });

  test("a failed act is recorded as failed", async () => {
    const ledger = fakeLedger();
    ledger.approve("bo");
    const failed = await gatedStateOp(input(ledger, "2026-10-27T09:00:00Z"), async () => {
      throw new Error("force-unlock failed");
    });
    expect(failed.status).toBe("failed");
    expect(ledger.writes.at(-1)).toBe('finished:failed:{"error":"force-unlock failed"}');
  });

  test("a request with an attachment keeps its time while the proof is the same, and asks anew when it changes", async () => {
    const ledger = fakeLedger();
    const ask = (now: string, proof: string) => gatedStateOp({ ...input(ledger, now), attachment: proof }, async () => ({ output: 0 }));
    const first = await ask("2026-10-27T09:00:00Z", '{"roots":["net"]}');
    expect(first.request.fields.proof).toBe(attachmentDigest('{"roots":["net"]}'));
    expect((await ask("2026-10-27T10:00:00Z", '{"roots":["net"]}')).request.at).toBe("2026-10-27T09:00:00Z");
    expect((await ask("2026-10-27T11:00:00Z", '{"roots":["net","app"]}')).request.at).toBe("2026-10-27T11:00:00Z");
  });

  test("requestedAt asks anew when the fields differ", async () => {
    const ledger = fakeLedger();
    await gatedStateOp(input(ledger, "2026-10-27T09:00:00Z"), async () => ({ output: 0 }));
    const other = await requestedAt(STATE_OPS.unlock, { kind: "unlock", subject: "net", by: "ana", fields: { id: "c3d4", location: "s3://b/net.tflock" } }, { now: "2026-10-27T12:00:00Z", ledger });
    expect(other).toBe("2026-10-27T12:00:00Z");
  });
});
