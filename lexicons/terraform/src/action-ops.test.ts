/**
 * #4653: an action block invoked on its own under a gated request, on an
 * injected exec and an injected ledger, so no binary runs and no ledger is
 * written.
 */
import { describe, expect, test } from "vitest";
import { gatedRequestDigest, type GatedRequest } from "@intentius/chant/lifecycle/gated-request";
import type { BinaryExec } from "./state/exec";
import type { GatedRequestLedger } from "./state-ops";
import { ACTION_ADDRESS, ACTION_OP, actionInvocationsDigest, actionSubject, invokeAction, invokesActions, terraformActionCapability, type InvokeActionInput } from "./action-ops";
import { TERRAFORM_VERB_FAMILIES, terraformCapabilityPlugin } from "./components/capability-plugin";

const ROTATE = "action.aws_lambda_invoke.rotate";

const planWith = (address: string, payload: string) => ({
  format_version: "1.2",
  terraform_version: "1.14.9",
  action_invocations: [{ address, type: "aws_lambda_invoke", name: "rotate", provider_name: "registry.terraform.io/hashicorp/aws", config_values: { function_name: "rotate", payload }, invoke_action_trigger: {} }],
});

/** An exec that records each argument list and prints `plan` for `show -json`. */
function recorder(state: { plan: unknown; fail?: string }): { exec: BinaryExec; calls: string[][]; binaries: string[] } {
  const calls: string[][] = [];
  const binaries: string[] = [];
  const exec: BinaryExec = async (binary, args) => {
    calls.push(args);
    binaries.push(binary);
    if (state.fail && args[0] === state.fail) return { code: 1, stdout: "", out: "Error: the action failed\nexit status 1" };
    if (args[0] === "show") return { code: 0, stdout: JSON.stringify(state.plan), out: "" };
    if (args[0] === "version") return { code: 0, stdout: JSON.stringify({ terraform_version: "1.14.9" }), out: "" };
    if (args[0] === "apply") return { code: 0, stdout: "", out: "Action started: action.aws_lambda_invoke.rotate\nApply complete! Resources: 0 added, 0 changed, 0 destroyed." };
    return { code: 0, stdout: "", out: "" };
  };
  return { exec, calls, binaries };
}

/**
 * A ledger in memory with chant's rules: the digest is chant's over the
 * request, an approval counts for its own digest, the requester's own
 * approval stands and does not count, and a digest applies once.
 */
function fakeLedger(): GatedRequestLedger & { approve(digest: string, by: string): void; lines: Array<Record<string, unknown>>; pending: number } {
  const approvals = new Map<string, string[]>();
  const asked: GatedRequest[] = [];
  const spent = new Set<string>();
  const lines: Array<Record<string, unknown>> = [];
  const self = {
    lines,
    pending: 0,
    approve(digest: string, by: string) {
      approvals.set(digest, [...(approvals.get(digest) ?? []), by]);
    },
    async requestGate(input: Parameters<GatedRequestLedger["requestGate"]>[0]) {
      const request = input.request;
      const digest = gatedRequestDigest(input.op, request);
      if (spent.has(digest)) return { status: "spent" as const, digest, request };
      if (!asked.some((r) => gatedRequestDigest(input.op, r) === digest)) {
        asked.push(request);
        self.pending++;
      }
      const command = `chant approve ${input.op} ${request.subject} --plan ${digest}`;
      const by = approvals.get(digest) ?? [];
      const counting = by.find((b) => b !== request.by);
      if (counting) return { status: "approved" as const, digest, request, approval: { version: 1, kind: "resolution", op: input.op, gate: request.subject, resolvedBy: counting, timestamp: "2026-10-28T10:00:00Z" } as never };
      if (by.length > 0) return { status: "refused" as const, digest, request, by: by[0]!, reason: `${by[0]} made the request, and a requester's own approval does not count`, command };
      return { status: "waiting" as const, digest, request, command };
    },
    async spendGatedRequest(input: Parameters<GatedRequestLedger["spendGatedRequest"]>[0]) {
      spent.add(input.digest);
      const line = { kind: "applied", op: input.op, gate: input.gate, planDigest: input.digest, approvedBy: input.approval.resolvedBy, timestamp: "2026-10-28T11:00:00Z" };
      lines.push(line);
      return line as never;
    },
    async finishGatedRequest(input: Parameters<GatedRequestLedger["finishGatedRequest"]>[0]) {
      lines.push({ kind: "finished", op: input.op, gate: input.gate, planDigest: input.digest, result: input.result, detail: input.detail });
      return { record: {} as never, pushed: true };
    },
    async readGatedRequests(op: string) {
      return asked.map((request) => {
        const digest = gatedRequestDigest(op, request);
        return { op, gate: request.subject, digest, request, pending: { expiresAt: "2099-01-01T00:00:00Z" } as never, approvals: [], ...(spent.has(digest) ? { applied: {} as never } : {}) };
      });
    },
  };
  return self;
}

const base = (exec: BinaryExec, ledger: GatedRequestLedger, over: Partial<InvokeActionInput> = {}): InvokeActionInput => ({
  root: "apps/orders",
  dir: "/repo/apps/orders",
  binary: "terraform",
  version: "1.14.9",
  address: ROTATE,
  requester: "ana",
  rules: { mode: "ledger" },
  planFile: "/w/action.tfplan",
  lockTimeout: false,
  env: {},
  exec,
  ledger,
  now: "2026-10-28T09:00:00Z",
  ...over,
});

const PLAN_ARGS = ["plan", "-input=false", "-no-color", `-invoke=${ROTATE}`, "-out=/w/action.tfplan"];
const SHOW_ARGS = ["show", "-json", "/w/action.tfplan"];
const APPLY_ARGS = ["apply", "-input=false", "-no-color", "/w/action.tfplan"];

describe("invokeAction", () => {
  test("a first call plans the invocation, asks, and answers gated with the digest, with no apply", async () => {
    const { exec, calls } = recorder({ plan: planWith(ROTATE, "v1") });
    const ledger = fakeLedger();
    const first = await invokeAction(base(exec, ledger));
    expect(first).toMatchObject({ outcome: "gated", subject: actionSubject("apps/orders", ROTATE), exit: 3 });
    expect(first.outcome === "gated" && first.digest).toMatch(/^sha256:/);
    expect(calls).toEqual([PLAN_ARGS, SHOW_ARGS]);
    expect(ledger.pending).toBe(1);
    expect(ledger.lines).toEqual([]);
  });

  test("after a second principal approves, it spends, applies once, and records ok; a third call is spent and runs nothing", async () => {
    const state = { plan: planWith(ROTATE, "v1") };
    const ledger = fakeLedger();
    const first = recorder(state);
    const gated = await invokeAction(base(first.exec, ledger));
    if (gated.outcome !== "gated") throw new Error(gated.outcome);
    ledger.approve(gated.digest, "bo");

    const second = recorder(state);
    const ok = await invokeAction(base(second.exec, ledger, { now: "2026-10-28T12:00:00Z" }));
    expect(ok).toMatchObject({ outcome: "ok", digest: gated.digest, approvedBy: "bo", exit: 0, recorded: true });
    expect(second.calls).toEqual([PLAN_ARGS, SHOW_ARGS, APPLY_ARGS]);
    expect(ledger.lines.map((l) => l.kind)).toEqual(["applied", "finished"]);
    const finished = ledger.lines[1]!;
    expect(finished).toMatchObject({ op: ACTION_OP, gate: "apps/orders:" + ROTATE, result: "applied" });
    expect(finished.detail).toMatchObject({ result: "ok", exit: 0, address: ROTATE });
    expect(String((finished.detail as Record<string, unknown>).tail)).toContain("Apply complete!");

    const third = recorder(state);
    const spent = await invokeAction(base(third.exec, ledger, { now: "2026-10-28T13:00:00Z" }));
    expect(spent).toMatchObject({ outcome: "spent", digest: gated.digest });
    expect(third.calls.some((a) => a[0] === "apply")).toBe(false);
    expect(ledger.lines).toHaveLength(2);

    const anew = recorder(state);
    const fourth = await invokeAction(base(anew.exec, ledger, { now: "2026-10-28T14:00:00Z", anew: true }));
    expect(fourth.outcome).toBe("gated");
    expect(fourth.outcome === "gated" && fourth.digest).not.toBe(gated.digest);
    expect(anew.calls.some((a) => a[0] === "apply")).toBe(false);
  });

  test("an approval by the requester alone leaves the call gated", async () => {
    const { exec, calls } = recorder({ plan: planWith(ROTATE, "v1") });
    const ledger = fakeLedger();
    const first = await invokeAction(base(exec, ledger));
    if (first.outcome !== "gated") throw new Error(first.outcome);
    ledger.approve(first.digest, "ana");
    const again = await invokeAction(base(exec, ledger, { now: "2026-10-28T12:00:00Z" }));
    expect(again).toMatchObject({ outcome: "gated", digest: first.digest, exit: 3 });
    expect(again.outcome === "gated" && again.reason).toMatch(/requester's own approval/);
    expect(calls.some((a) => a[0] === "apply")).toBe(false);
    expect(ledger.lines).toEqual([]);
  });

  test("an address the plan does not invoke is refused with unknown-action and nothing applies", async () => {
    const { exec, calls } = recorder({ plan: planWith("action.aws_lambda_invoke.flush", "v1") });
    const ledger = fakeLedger();
    const out = await invokeAction(base(exec, ledger));
    expect(out).toMatchObject({ outcome: "refused", code: "unknown-action", exit: 1 });
    expect(out.outcome === "refused" && out.reason).toContain("action.aws_lambda_invoke.flush");
    expect(calls.some((a) => a[0] === "apply")).toBe(false);
    expect(ledger.pending).toBe(0);
  });

  test("OpenTofu and choudoufu are refused with action-engine, by the engine's name, before any exec call", async () => {
    for (const [binary, version, engine] of [
      ["tofu", "1.13.1", "OpenTofu"],
      ["/usr/local/bin/tofu", undefined, "OpenTofu"],
      ["choudoufu", "0.31.0", "choudoufu"],
    ] as const) {
      const { exec, calls } = recorder({ plan: planWith(ROTATE, "v1") });
      const out = await invokeAction(base(exec, fakeLedger(), { binary, ...(version ? { version } : { version: undefined }) }));
      expect(out).toMatchObject({ outcome: "refused", code: "action-engine" });
      expect(out.outcome === "refused" && out.reason).toContain(engine);
      if (version) expect(out.outcome === "refused" && out.reason).toContain(version);
      expect(calls).toEqual([]);
    }
  });

  test("a Terraform older than 1.14 is refused before the plan, by the version given or read", async () => {
    const given = recorder({ plan: planWith(ROTATE, "v1") });
    expect(await invokeAction(base(given.exec, fakeLedger(), { version: "1.13.4" }))).toMatchObject({ outcome: "refused", code: "action-engine" });
    expect(given.calls).toEqual([]);

    const read: string[][] = [];
    const old: BinaryExec = async (_b, args) => {
      read.push(args);
      return { code: 0, stdout: JSON.stringify({ terraform_version: "1.12.2" }), out: "" };
    };
    const out = await invokeAction(base(old, fakeLedger(), { version: undefined }));
    expect(out).toMatchObject({ outcome: "refused", code: "action-engine" });
    expect(out.outcome === "refused" && out.reason).toContain("1.12.2");
    expect(read).toEqual([["version", "-json"]]);
  });

  test("with no version given, a 1.14 binary's version is read first, then the plan runs", async () => {
    const { exec, calls } = recorder({ plan: planWith(ROTATE, "v1") });
    await invokeAction(base(exec, fakeLedger(), { version: undefined }));
    expect(calls).toEqual([["version", "-json"], PLAN_ARGS, SHOW_ARGS]);
  });

  test("a plan whose action_invocations changed after the approval has a new digest and is gated again", async () => {
    const state = { plan: planWith(ROTATE, "v1") as unknown };
    const ledger = fakeLedger();
    const first = await invokeAction(base(recorder(state).exec, ledger));
    if (first.outcome !== "gated") throw new Error(first.outcome);
    ledger.approve(first.digest, "bo");
    state.plan = planWith(ROTATE, "v2");
    const moved = recorder(state);
    const again = await invokeAction(base(moved.exec, ledger, { now: "2026-10-28T12:00:00Z" }));
    expect(again.outcome).toBe("gated");
    expect(again.outcome === "gated" && again.digest).not.toBe(first.digest);
    expect(moved.calls.some((a) => a[0] === "apply")).toBe(false);
    expect(ledger.lines).toEqual([]);
  });

  test("the commit joins the request, so another commit asks anew", async () => {
    const state = { plan: planWith(ROTATE, "v1") };
    const ledger = fakeLedger();
    const a = await invokeAction(base(recorder(state).exec, ledger, { commit: "aaaa" }));
    const b = await invokeAction(base(recorder(state).exec, ledger, { commit: "bbbb", now: "2026-10-28T12:00:00Z" }));
    expect(a.outcome === "gated" && b.outcome === "gated" && a.digest !== b.digest).toBe(true);
  });

  test("an action in a module is invoked by its module address", async () => {
    const address = "module.app.action.aws_lambda_invoke.rotate";
    const { exec, calls } = recorder({ plan: planWith(address, "v1") });
    const out = await invokeAction(base(exec, fakeLedger(), { address }));
    expect(out).toMatchObject({ outcome: "gated", subject: `apps/orders:${address}` });
    expect(calls[0]).toContain(`-invoke=${address}`);
  });

  test("an address that is not an action's is refused before anything runs", async () => {
    for (const address of ["aws_lambda_function.rotate", "-help", "action.aws_lambda_invoke", "module.app.aws_s3_bucket.b", "action.x.y -target=z"]) {
      const { exec, calls } = recorder({ plan: planWith(ROTATE, "v1") });
      expect(await invokeAction(base(exec, fakeLedger(), { address }))).toMatchObject({ outcome: "refused", code: "action-address" });
      expect(calls).toEqual([]);
    }
  });

  test("a failed apply is recorded as failed, with the exit code and the last lines in the detail", async () => {
    const state = { plan: planWith(ROTATE, "v1"), fail: "apply" };
    const ledger = fakeLedger();
    const first = await invokeAction(base(recorder(state).exec, ledger));
    if (first.outcome !== "gated") throw new Error(first.outcome);
    ledger.approve(first.digest, "bo");
    const out = await invokeAction(base(recorder(state).exec, ledger, { now: "2026-10-28T12:00:00Z" }));
    expect(out).toMatchObject({ outcome: "failed", exit: 1 });
    expect(ledger.lines[1]).toMatchObject({ kind: "finished", result: "failed" });
    expect(ledger.lines[1]!.detail).toMatchObject({ result: "failed", exit: 1, address: ROTATE });
  });
});

describe("addresses and versions", () => {
  test("the address pattern takes root and module addresses, instance keys included", () => {
    for (const ok of [ROTATE, "module.app.action.aws_lambda_invoke.rotate", "module.a.module.b.action.t.l", "module.mod[1].action.t.l", 'module.m["blue"].action.t.l', "action.t.l[0]"]) expect(ACTION_ADDRESS.test(ok)).toBe(true);
    for (const no of ["action.t", "resource.t.l", "module.app.t.l", "module..action.t.l", 'action.t.l["a b"]', "action.T-x.l"]) expect(ACTION_ADDRESS.test(no)).toBe(false);
  });

  test("Terraform 1.14 and newer invoke actions", () => {
    expect(invokesActions("1.14.0")).toBe(true);
    expect(invokesActions("1.14.9")).toBe(true);
    expect(invokesActions("v1.15.8")).toBe(true);
    expect(invokesActions("2.0.0")).toBe(true);
    expect(invokesActions("1.13.9")).toBe(false);
    expect(invokesActions("dev")).toBe(false);
  });

  test("the invocations digest does not follow key or entry order", () => {
    const a = { action_invocations: [{ address: "action.t.a", type: "t" }, { type: "t", address: "action.t.b" }] };
    const b = { action_invocations: [{ address: "action.t.b", type: "t" }, { type: "t", address: "action.t.a" }] };
    expect(actionInvocationsDigest(a)).toBe(actionInvocationsDigest(b));
    expect(actionInvocationsDigest(a)).not.toBe(actionInvocationsDigest({ action_invocations: [{ address: "action.t.a", type: "t" }] }));
  });
});

describe("terraform-action capability", () => {
  test("is registered in the plugin, in its own family", () => {
    expect(terraformCapabilityPlugin.capabilities().map((c) => c.kind)).toContain("terraform-action");
    expect(TERRAFORM_VERB_FAMILIES.action).toEqual(["terraform-action"]);
    expect(terraformActionCapability.rollbackPolicy).toBe("none-by-design");
  });
});
