/**
 * #3760: `chant approve policy-override <subject> --rule <id> --reason <text>`
 * records an override of the subject's recorded denial, for exactly that
 * plan and those rules.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { ParsedArgs } from "../registry";
import { overrideDigest, overridePending, OVERRIDE_OP } from "../../override-gate";

const recordGateApprovalMock = vi.fn();
const readOverrideLedgerMock = vi.fn();
const requireLifecycleLedgerMock = vi.fn();
const originMock = vi.fn(() => "cli");

vi.mock("./operator", () => ({ recordGateApproval: (...a: unknown[]) => recordGateApprovalMock(...a) }));
vi.mock("../../lifecycle/override-ledger", () => ({ readOverrideLedger: (...a: unknown[]) => readOverrideLedgerMock(...a) }));
vi.mock("../../lifecycle/git", () => ({ requireLifecycleLedger: (...a: unknown[]) => requireLifecycleLedgerMock(...a) }));
vi.mock("../../lifecycle/gate-origin", async () => {
  const actual = await vi.importActual<typeof import("../../lifecycle/gate-origin")>("../../lifecycle/gate-origin");
  return { ...actual, currentGateOrigin: () => originMock() };
});

const { runOverrideApprove } = await import("./override-approve");

const PLAN = `sha256:${"a".repeat(64)}`;
const DENIAL = overridePending({ subject: "prod", planDigest: PLAN, rules: ["no-drop", "no-lock"], timestamp: "2026-10-11T10:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z" });

function ctx(args: Partial<ParsedArgs>) {
  return {
    args: { command: "approve", path: OVERRIDE_OP, extraPositional: "prod", format: "", fix: false, watch: false, verbose: false, help: false, live: false, ...args } as ParsedArgs,
    plugins: [],
    serializers: [],
  };
}

let err: ReturnType<typeof vi.spyOn>;
const printed = () => err.mock.calls.flat().join("\n");

beforeEach(() => {
  vi.clearAllMocks();
  err = vi.spyOn(console, "error").mockImplementation(() => undefined);
  originMock.mockReturnValue("cli");
  requireLifecycleLedgerMock.mockResolvedValue(undefined);
  readOverrideLedgerMock.mockResolvedValue({ resolutions: [], pending: [DENIAL], applied: [] });
  recordGateApprovalMock.mockResolvedValue({ ok: true, pushed: true, record: { version: 1, op: OVERRIDE_OP, gate: "prod", resolvedBy: "github:alice", timestamp: "2026-10-11T11:00:00.000Z" } });
});

describe("chant approve policy-override", () => {
  test("approves the denial's override digest with the reason as its note", async () => {
    const code = await runOverrideApprove(ctx({ rules: ["no-lock", "no-drop"], reason: " the table is empty ", actor: "github:alice", sign: true }));
    expect(code).toBe(0);
    expect(recordGateApprovalMock).toHaveBeenCalledWith(OVERRIDE_OP, "prod", expect.objectContaining({
      actor: "github:alice", note: "the table is empty", plan: overrideDigest("prod", PLAN, ["no-drop", "no-lock"]), sign: true,
    }));
    expect(printed()).toMatch(/overrides the denial of prod by no-drop, no-lock for the plan sha256:a{64}/);
  });

  test("--note is the same field as --reason", async () => {
    expect(await runOverrideApprove(ctx({ rules: ["no-drop", "no-lock"], note: "empty table" }))).toBe(0);
    expect(recordGateApprovalMock).toHaveBeenCalledWith(OVERRIDE_OP, "prod", expect.objectContaining({ note: "empty table" }));
    expect(await runOverrideApprove(ctx({ rules: ["no-drop", "no-lock"], note: "a", reason: "b" }))).toBe(1);
  });

  test.each<[string, Partial<ParsedArgs>, RegExp]>([
    ["no rule", { reason: "why" }, /names each rule it overrides with --rule/],
    ["no reason", { rules: ["no-drop", "no-lock"], reason: "  " }, /needs --reason/],
    ["other rules", { rules: ["no-drop"], reason: "why" }, /denied by no-drop, no-lock; an override names exactly those rules, and --rule gave no-drop/],
    ["another plan", { rules: ["no-drop", "no-lock"], reason: "why", plan: `sha256:${"b".repeat(64)}` }, /is not the plan denied for prod/],
    ["an agent", { rules: ["no-drop", "no-lock"], reason: "why", agent: true }, /An override is a person.s/],
    ["no denial", { rules: ["x"], reason: "why", extraPositional: "staging" }, /No denial of staging is recorded on policy-override; denied: prod/],
  ])("refuses %s, and records nothing", async (_name, args, why) => {
    expect(await runOverrideApprove(ctx(args))).toBe(1);
    expect(printed()).toMatch(why);
    expect(recordGateApprovalMock).not.toHaveBeenCalled();
  });

  test("is refused over MCP", async () => {
    originMock.mockReturnValue("mcp");
    expect(await runOverrideApprove(ctx({ rules: ["no-drop", "no-lock"], reason: "why" }))).toBe(1);
    expect(recordGateApprovalMock).not.toHaveBeenCalled();
  });

  test("--plan may name the denied plan or the override digest", async () => {
    expect(await runOverrideApprove(ctx({ rules: ["no-drop", "no-lock"], reason: "why", plan: PLAN }))).toBe(0);
    expect(await runOverrideApprove(ctx({ rules: ["no-drop", "no-lock"], reason: "why", plan: DENIAL.planDigest }))).toBe(0);
  });

  describe("the overriders check (#3824)", () => {
    const args = { rules: ["no-drop", "no-lock"], reason: "why" };
    test("warns when this checkout lists no overriders", async () => {
      vi.stubEnv("CHANT_OVERRIDERS_FROM", "");
      expect(await runOverrideApprove(ctx(args))).toBe(0);
      expect(printed()).toMatch(/has no \.chant\/overriders/);
    });
    test("is skipped when the caller says where it reads its overriders", async () => {
      vi.stubEnv("CHANT_OVERRIDERS_FROM", "policy.override in terragucci.config.ts");
      expect(await runOverrideApprove(ctx(args))).toBe(0);
      expect(printed()).toMatch(/overrides the denial of prod/);
      expect(printed()).not.toMatch(/overriders/);
      vi.unstubAllEnvs();
    });
  });
});
