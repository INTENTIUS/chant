import { describe, expect, test } from "vitest";
import { buildChangeSet } from "./change-set";
import { evaluateUnobservedGate } from "./unobserved-gate";
import type { ChangeSet } from "./change-set";
import type { UnobservedReason } from "../observation";

const cleanChangeSet = (env = "prod"): ChangeSet =>
  buildChangeSet(env, {
    declared: new Set(["bucket"]),
    observedNow: { bucket: { type: "Fake::Bucket", status: "OK" } },
    observedThen: undefined,
  });

const unobservedChangeSet = (reason: UnobservedReason, detail?: string): ChangeSet =>
  buildChangeSet("prod", {
    declared: new Set(["queue"]),
    observedNow: {},
    observedThen: undefined,
    unobserved: { queue: { reason, ...(detail ? { detail } : {}) } },
  });

describe("evaluateUnobservedGate (#1568)", () => {
  test("a clean change set passes under every policy", () => {
    const cs = cleanChangeSet();
    expect(evaluateUnobservedGate(cs)).toEqual({ pass: true, escalate: false, findings: [] });
    expect(evaluateUnobservedGate(cs, "escalate")).toEqual({ pass: true, escalate: false, findings: [] });
    expect(evaluateUnobservedGate(cs, { allow: [] })).toEqual({ pass: true, escalate: false, findings: [] });
  });

  test("default policy (no argument) refuses a plan with an unobserved entity", () => {
    const cs = unobservedChangeSet("no-credentials", "aws sts get-caller-identity: access denied");
    const verdict = evaluateUnobservedGate(cs);
    expect(verdict.pass).toBe(false);
    expect(verdict.escalate).toBe(false);
    expect(verdict.findings).toEqual([
      { name: "queue", reason: "no-credentials", detail: "aws sts get-caller-identity: access denied" },
    ]);
    expect(verdict.detail).toContain("queue");
    expect(verdict.detail).toContain("no credentials");
  });

  test('explicit "refuse" behaves the same as the default', () => {
    const cs = unobservedChangeSet("read-failed");
    expect(evaluateUnobservedGate(cs, "refuse").pass).toBe(false);
  });

  test('"escalate" does not fail the gate but flags escalate with the findings', () => {
    const cs = unobservedChangeSet("no-binding");
    const verdict = evaluateUnobservedGate(cs, "escalate");
    expect(verdict.pass).toBe(true);
    expect(verdict.escalate).toBe(true);
    expect(verdict.findings).toHaveLength(1);
    expect(verdict.findings[0].reason).toBe("no-binding");
    expect(verdict.detail).toBeDefined();
  });

  test("an allowed reason passes cleanly and is not counted as a finding", () => {
    const cs = unobservedChangeSet("filtered");
    const verdict = evaluateUnobservedGate(cs, { allow: ["filtered"] });
    expect(verdict).toEqual({ pass: true, escalate: false, findings: [] });
  });

  test("a reason outside the allow list still refuses", () => {
    const cs = unobservedChangeSet("no-credentials");
    const verdict = evaluateUnobservedGate(cs, { allow: ["filtered"] });
    expect(verdict.pass).toBe(false);
    expect(verdict.findings[0].reason).toBe("no-credentials");
  });

  test("a mixed change set with one allowed and one unallowed reason only reports the unallowed one", () => {
    const cs = buildChangeSet("prod", {
      declared: new Set(["a", "b"]),
      observedNow: {},
      observedThen: undefined,
      unobserved: {
        a: { reason: "filtered" },
        b: { reason: "unsupported-kind" },
      },
    });
    const verdict = evaluateUnobservedGate(cs, { allow: ["filtered"] });
    expect(verdict.pass).toBe(false);
    expect(verdict.findings).toEqual([{ name: "b", reason: "unsupported-kind" }]);
  });

  test("never escalates or refuses on create/update/delete/adopt/noop — only `unobserved` counts", () => {
    const cs = buildChangeSet("prod", {
      declared: new Set(["created", "updated"]),
      observedNow: {
        updated: { type: "Fake::Resource", status: "DRIFTED" },
        orphan: { type: "Fake::Resource", status: "OK" },
      },
      observedThen: { updated: { type: "Fake::Resource", status: "OK" } },
    });
    expect(evaluateUnobservedGate(cs)).toEqual({ pass: true, escalate: false, findings: [] });
  });

  test("carries type and detail through into the finding when present", () => {
    const cs = buildChangeSet("prod", {
      declared: new Set(["disk"]),
      observedNow: {},
      observedThen: undefined,
      unobserved: { disk: { reason: "unsupported-kind", detail: "no describe support for this kind yet", type: "Fake::Disk" } },
    });
    const verdict = evaluateUnobservedGate(cs);
    expect(verdict.findings).toEqual([
      { name: "disk", type: "Fake::Disk", reason: "unsupported-kind", detail: "no describe support for this kind yet" },
    ]);
  });
});
