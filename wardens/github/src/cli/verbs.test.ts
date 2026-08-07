/**
 * #790 — every cycle stamps a governance verb, so this provider's plans read
 * on the same cross-provider grammar as every other warden's (and, later,
 * the cloud wardens' — epic #787 C2).
 */
import { describe, expect, it } from "vitest";
import { isGovernanceVerb } from "@intentius/chant/governance";
import { CYCLE_REGISTRY } from "./registry.js";

describe("governance verbs (#790)", () => {
  it("every registered cycle stamps a valid verb", () => {
    for (const [name, cycle] of Object.entries(CYCLE_REGISTRY)) {
      expect(isGovernanceVerb(cycle.verb), `cycle "${name}" stamps no governance verb`).toBe(true);
    }
  });
});
