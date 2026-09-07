/**
 * The `signalName` -> `gate` rename (#2202) and the one-version bridge that
 * keeps the old key readable through 0.59.0.
 */
import { describe, it, expect } from "vitest";
import { gateName, usesDeprecatedGateKey, opUsesDeprecatedGateKey } from "./gate-name";
import type { OpConfig } from "./types";

describe("gateName", () => {
  it("reads the new key", () => {
    expect(gateName({ gate: "approve-prod" })).toBe("approve-prod");
  });

  it("falls back to the deprecated key", () => {
    expect(gateName({ signalName: "approve-prod" })).toBe("approve-prod");
  });

  it("prefers the new key when a step somehow carries both", () => {
    expect(gateName({ gate: "new", signalName: "old" })).toBe("new");
  });
});

describe("usesDeprecatedGateKey", () => {
  it("is true only when the new key is absent", () => {
    expect(usesDeprecatedGateKey({ signalName: "old" })).toBe(true);
    expect(usesDeprecatedGateKey({ gate: "new" })).toBe(false);
    expect(usesDeprecatedGateKey({ gate: "new", signalName: "old" })).toBe(false);
    expect(usesDeprecatedGateKey({})).toBe(false);
  });
});

describe("opUsesDeprecatedGateKey", () => {
  const op = (phases: OpConfig["phases"], onFailure?: OpConfig["phases"]): OpConfig =>
    ({ name: "x", overview: "x", phases, ...(onFailure ? { onFailure } : {}) }) as OpConfig;

  it("finds a gate on the old key in a plain phase", () => {
    expect(opUsesDeprecatedGateKey(op([{ name: "Approve", steps: [{ kind: "gate", signalName: "go" }] }]))).toBe(true);
  });

  it("finds one nested inside an effect step", () => {
    const config = op([
      {
        name: "Seed",
        steps: [
          {
            kind: "effect",
            receipt: { name: "seeded", effect: "db-seed", flavor: "hash", inputs: { file: "seed.sql" } },
            steps: [{ kind: "gate", signalName: "go" }],
          },
        ],
      },
    ]);
    expect(opUsesDeprecatedGateKey(config)).toBe(true);
  });

  it("finds one in an onFailure phase", () => {
    expect(
      opUsesDeprecatedGateKey(op([{ name: "Apply", steps: [] }], [{ name: "Undo", steps: [{ kind: "gate", signalName: "go" }] }])),
    ).toBe(true);
  });

  it("is false for an Op on the new key", () => {
    expect(opUsesDeprecatedGateKey(op([{ name: "Approve", steps: [{ kind: "gate", gate: "go" }] }]))).toBe(false);
  });
});
