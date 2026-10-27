import { describe, expect, test } from "vitest";
import { CHANT_EXIT } from "@intentius/chant/exit-codes";
import { terraformExitOf, terraformPlanMoved } from "./exit-codes";

describe("terraform, tofu and choudoufu exit statuses on chant's table (#4553)", () => {
  test("choudoufu's refusals of a moved plan are chant's moved code", () => {
    expect(terraformExitOf({ command: "live-wave-apply", code: 3 })).toBe(CHANT_EXIT.moved);
    expect(terraformExitOf({ command: "apply", code: 3, refusal: "approval-mismatch" })).toBe(CHANT_EXIT.moved);
    expect(terraformPlanMoved({ command: "live-wave-apply", code: 3 })).toBe(true);
  });

  test("a plan made against another estate is a failure, and so is a root that failed", () => {
    expect(terraformExitOf({ command: "apply", code: 3, refusal: "wrong-estate" })).toBe(CHANT_EXIT.failed);
    expect(terraformExitOf({ command: "live-wave-apply", code: 4 })).toBe(CHANT_EXIT.failed);
    expect(terraformExitOf({ command: "live-plan-set", code: 4 })).toBe(CHANT_EXIT.failed);
  });

  test("a plan's 2 is drift only under a drift check", () => {
    expect(terraformExitOf({ command: "plan", code: 2 })).toBe(CHANT_EXIT.done);
    expect(terraformExitOf({ command: "plan", code: 2, drift: true })).toBe(CHANT_EXIT.drift);
    expect(terraformExitOf({ command: "plan", code: 1 })).toBe(CHANT_EXIT.failed);
  });
});
