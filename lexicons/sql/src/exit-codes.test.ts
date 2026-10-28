import { describe, expect, test } from "vitest";
import { CHANT_EXIT } from "@intentius/chant/exit-codes";
import { sqlExitOf, sqlPlanMoved, YODEL_LEGACY_EXIT, yodelExitOf } from "./exit-codes";

describe("SQL engine outcomes on chant's table (#4570)", () => {
  test("a moved wave plan and an approval of another digest are moved", () => {
    expect(sqlExitOf("plan-moved")).toBe(CHANT_EXIT.moved);
    expect(sqlExitOf("approval-moved")).toBe(CHANT_EXIT.moved);
    expect(sqlPlanMoved("plan-moved")).toBe(true);
    expect(sqlPlanMoved("checksum-mismatch")).toBe(false);
  });

  test("denial, lock, promotion and drift each have their own row", () => {
    expect(sqlExitOf("policy-denied")).toBe(CHANT_EXIT.denied);
    expect(sqlExitOf("lock-held")).toBe(CHANT_EXIT.held);
    expect(sqlExitOf("promotion-unmet")).toBe(CHANT_EXIT.waiting);
    expect(sqlExitOf("pending")).toBe(CHANT_EXIT.waiting);
    expect(sqlExitOf("drift")).toBe(CHANT_EXIT.drift);
    expect(sqlExitOf("stood-down")).toBe(CHANT_EXIT.superseded);
  });

  test("a refusal no approval fixes is failed, lint errors included", () => {
    for (const o of ["checksum-mismatch", "fork", "out-of-order", "directory", "shared-identity", "reader-write", "lint-errors"] as const) {
      expect(sqlExitOf(o)).toBe(CHANT_EXIT.failed);
    }
  });
});

describe("yodel exit statuses (#4570)", () => {
  test("a yodel on chant's table passes through", () => {
    for (const code of Object.values(CHANT_EXIT)) expect(yodelExitOf({ code })).toBe(code);
    expect(yodelExitOf({ code: 99 })).toBe(CHANT_EXIT.failed);
    expect(yodelExitOf({ code: null })).toBe(CHANT_EXIT.failed);
  });

  test("a legacy yodel's codes are read by meaning", () => {
    const legacy = true;
    expect(yodelExitOf({ code: YODEL_LEGACY_EXIT.needsOp, command: "drift", legacy })).toBe(CHANT_EXIT.drift);
    expect(yodelExitOf({ code: YODEL_LEGACY_EXIT.needsOp, command: "apply", legacy })).toBe(CHANT_EXIT.waiting);
    expect(yodelExitOf({ code: YODEL_LEGACY_EXIT.outstanding, command: "lint", legacy })).toBe(CHANT_EXIT.failed);
    expect(yodelExitOf({ code: YODEL_LEGACY_EXIT.outstanding, command: "status", legacy })).toBe(CHANT_EXIT.waiting);
    expect(yodelExitOf({ code: YODEL_LEGACY_EXIT.refused, command: "apply", legacy })).toBe(CHANT_EXIT.failed);
    expect(yodelExitOf({ code: YODEL_LEGACY_EXIT.locked, legacy })).toBe(CHANT_EXIT.held);
    expect(yodelExitOf({ code: 0, legacy })).toBe(CHANT_EXIT.done);
  });
});
