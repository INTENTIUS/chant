/**
 * Typed step-builder wrappers (chant #1288 Stage 2) — see
 * `lexicons/k8s/src/op/builders.test.ts`'s module doc for what's asserted
 * and why.
 */

import { describe, test, expect } from "vitest";
import { k3dUp as k3dUpOld, k3dDown as k3dDownOld, stepOutput, type StepOutputRef } from "@intentius/chant/op";
import { k3dUp, k3dDown } from "./builders";

describe("k3d typed step builders (#1288 Stage 2)", () => {
  test("k3dUp: identical ActivityStep to core's original", () => {
    expect(k3dUp("dev")).toEqual(k3dUpOld("dev"));
    const opts = { servers: 1, agents: 2, ports: ["8080:80@loadbalancer"] };
    expect(k3dUp("dev", opts)).toEqual(k3dUpOld("dev", opts));
  });

  test("k3dDown: identical ActivityStep to core's original", () => {
    expect(k3dDown("dev")).toEqual(k3dDownOld("dev"));
  });

  test("k3dUp: accepts a StepOutputRef in a typed slot", () => {
    const ref = stepOutput("resolve-config", "path");
    const step = k3dUp("dev", { configFile: ref });
    expect(step.args?.configFile).toBe(ref);
  });

  test("k3dUp: .out is reachable when an id is given", () => {
    const step = k3dUp("dev", { id: "cluster" });
    const ref: StepOutputRef = step.out.context;
    expect(ref.step).toBe("cluster");
    expect(ref.path).toBe("context");
  });
});

// ── Compile-time-only: authoring-time type errors (never executed) ──────────
function _typeChecksOnly(): void {
  // @ts-expect-error — "server" (missing the s) is not a key of K3dUpArgs.
  k3dUp("dev", { server: 1 });

  // @ts-expect-error — servers must be a number.
  k3dUp("dev", { servers: "1" });

  // @ts-expect-error — ports must be string[], not a single string.
  k3dUp("dev", { ports: "8080:80@loadbalancer" });
}
void _typeChecksOnly;
