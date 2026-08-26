/**
 * Typed step-builder wrappers (chant #1288 Stage 2) — see
 * `lexicons/k8s/src/op/builders.test.ts`'s module doc for what's asserted
 * and why.
 */

import { describe, test, expect } from "vitest";
import {
  azApply as azApplyOld,
  azDelete as azDeleteOld,
  azGroupEnsure as azGroupEnsureOld,
  azGroupDelete as azGroupDeleteOld,
  flociAzUp as flociAzUpOld,
  flociAzDown as flociAzDownOld,
  stepOutput,
  type StepOutputRef,
} from "@intentius/chant/op";
import { azApply, azDelete, azGroupEnsure, azGroupDelete, flociAzUp, flociAzDown } from "./builders";

describe("azure typed step builders (#1288 Stage 2)", () => {
  test("azGroupEnsure: identical ActivityStep to core's original", () => {
    expect(azGroupEnsure("my-rg")).toEqual(azGroupEnsureOld("my-rg"));
    expect(azGroupEnsure("my-rg", { location: "westus" })).toEqual(azGroupEnsureOld("my-rg", { location: "westus" }));
  });

  test("azGroupDelete: identical ActivityStep to core's original", () => {
    expect(azGroupDelete("my-rg")).toEqual(azGroupDeleteOld("my-rg"));
  });

  test("azApply: identical ActivityStep to core's original", () => {
    const opts = { resourceGroup: "my-rg" };
    expect(azApply("dist/template.json", opts)).toEqual(azApplyOld("dist/template.json", opts));
  });

  test("azDelete: identical ActivityStep to core's original", () => {
    const opts = { resourceGroup: "my-rg" };
    expect(azDelete("dist/template.json", opts)).toEqual(azDeleteOld("dist/template.json", opts));
  });

  test("flociAzUp/flociAzDown: identical ActivityStep to core's original", () => {
    expect(flociAzUp()).toEqual(flociAzUpOld());
    expect(flociAzDown({ name: "custom" })).toEqual(flociAzDownOld({ name: "custom" }));
  });

  test("azApply: accepts a StepOutputRef in a typed slot", () => {
    const ref = stepOutput("resolve-rg", "resourceGroup");
    const step = azApply("dist/template.json", { resourceGroup: ref });
    expect(step.args?.resourceGroup).toBe(ref);
  });

  test("azGroupEnsure: .out is reachable when an id is given", () => {
    const step = azGroupEnsure("my-rg", { id: "ensure-rg" });
    const ref: StepOutputRef = step.out.location;
    expect(ref.step).toBe("ensure-rg");
  });
});

// ── Compile-time-only: authoring-time type errors (never executed) ──────────
function _typeChecksOnly(): void {
  // @ts-expect-error — resourceGroup is required for azApply (the activity
  // fails without it); omitting opts entirely is no longer a way around that.
  azApply("dist/template.json");

  // @ts-expect-error — "resourcegroup" (wrong case) is not a key of AzApplyArgs.
  azApply("dist/template.json", { resourcegroup: "my-rg" });

  // @ts-expect-error — prune must be a boolean.
  azApply("dist/template.json", { resourceGroup: "my-rg", prune: "yes" });

  // @ts-expect-error — location must be a string.
  azGroupEnsure("my-rg", { location: 1 });
}
void _typeChecksOnly;
