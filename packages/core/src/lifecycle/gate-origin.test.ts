import { describe, test, expect, afterEach } from "vitest";
import {
  currentGateOrigin,
  setGateOrigin,
  resetGateOrigin,
  isModelAuthored,
  sameOriginRefusal,
  UNATTESTED_APPROVER,
} from "./gate-origin";

/**
 * chant#2384 — the gate's two halves must have different authors.
 *
 * The gate as a durable, plan-bound fact is the strongest thing chant says
 * about agent-driven change: a run reaching an unapproved gate records a
 * pending fact and exits 3, and since #2300 a resolution counts only for the
 * plan it names. All of that rests on the run and the approval being authored
 * by different parties.
 *
 * At a shell they are, and the ledger's existing stance is right there: anyone
 * who can run `chant approve` can also run `chant run`, the same trust boundary
 * a local commit has. On MCP and ACP it stops being right, because the person's
 * only act was launching the server — `op-run` returns the gate it stopped on
 * and `op-approve` resolves it, both authored by the same model in the same
 * session, and #2300's plan binding does not close it because the digest comes
 * off the pending fact that same caller produced one tool call earlier.
 */
describe("gate origin (chant#2384)", () => {
  afterEach(() => resetGateOrigin());

  test("the process serves one channel, and it is the CLI unless an entry point says otherwise", () => {
    expect(currentGateOrigin()).toBe("cli");
    setGateOrigin("mcp");
    expect(currentGateOrigin()).toBe("mcp");
    resetGateOrigin();
    expect(currentGateOrigin()).toBe("cli");
  });

  test("only MCP and ACP are model-authored", () => {
    expect(isModelAuthored("mcp")).toBe(true);
    expect(isModelAuthored("acp")).toBe(true);
    // The distinction the whole rule rests on: at a shell a person typed each
    // command, so the two halves already have different authors.
    expect(isModelAuthored("cli")).toBe(false);
    expect(isModelAuthored(undefined)).toBe(false);
  });

  describe("the same-origin rule", () => {
    test("refuses a gate reached and resolved on the same model-authored channel", () => {
      expect(sameOriginRefusal("mcp", "mcp")).toContain("the same caller wrote both halves");
      expect(sameOriginRefusal("acp", "acp")).toContain("the same caller wrote both halves");
    });

    test("allows run-then-approve at a shell, which is the intended workflow", () => {
      // Both halves are `cli` and that is fine. This is the case the issue is
      // explicit about keeping: `chant approve` typed at a shell followed by
      // `chant run` still walks through.
      expect(sameOriginRefusal("cli", "cli")).toBeUndefined();
    });

    test("allows a model's run approved by a person, which is the separation the gate is for", () => {
      expect(sameOriginRefusal("mcp", "cli")).toBeUndefined();
      expect(sameOriginRefusal("acp", "cli")).toBeUndefined();
    });

    test("allows a person's run approved over MCP, since a person still authored one half", () => {
      expect(sameOriginRefusal("cli", "mcp")).toBeUndefined();
    });

    test("refuses across the two model channels only when they are the same one", () => {
      // Distinct model channels are two sessions, not one caller writing both
      // halves — so this is permitted, and deliberately so.
      expect(sameOriginRefusal("mcp", "acp")).toBeUndefined();
      expect(sameOriginRefusal("acp", "mcp")).toBeUndefined();
    });

    test("an unlabelled pending fact is never refused, so old ledgers keep working", () => {
      // Every record written before this change has no origin. Absent is not
      // "cli" and not a wildcard: the rule fires on a positive match only, so a
      // pre-#2384 pending fact cannot start refusing approvals retroactively.
      expect(sameOriginRefusal(undefined, "mcp")).toBeUndefined();
      expect(sameOriginRefusal(undefined, "acp")).toBeUndefined();
      expect(sameOriginRefusal(undefined, "cli")).toBeUndefined();
    });
  });

  test("the unattested approver is a fixed marker, not a name anyone chose", () => {
    // `op-approve` took a free-text `approver` on a channel that cannot verify
    // one, so the model named itself whatever it liked and the ledger recorded
    // it indistinguishably from a name a person gave.
    expect(UNATTESTED_APPROVER).toBe("unattested");
  });
});
