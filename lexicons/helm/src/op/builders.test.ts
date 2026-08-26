/**
 * Typed step-builder wrappers (chant #1288 Stage 2) — see
 * `lexicons/k8s/src/op/builders.test.ts`'s module doc for what's asserted
 * and why (backward compat against core's original, step-output-ref
 * composition, compile-time-only `@ts-expect-error` checks walked by
 * `npm run typecheck`).
 */

import { describe, test, expect } from "vitest";
import {
  helmInstall as helmInstallOld,
  helmInstallPinned as helmInstallPinnedOld,
  stepOutput,
  type StepOutputRef,
} from "@intentius/chant/op";
import { helmInstall, helmInstallPinned } from "./builders";

describe("helm typed step builders (#1288 Stage 2)", () => {
  test("helmInstall: identical ActivityStep to core's original for a minimal call", () => {
    expect(helmInstall("api", "./chart")).toEqual(helmInstallOld("api", "./chart"));
  });

  test("helmInstall: identical ActivityStep with opts (namespace, values, set, capabilityProfile)", () => {
    const opts = {
      namespace: "prod",
      values: "values.yaml",
      set: { "image.tag": "v2" },
      capabilityProfile: { kubeVersion: "1.29" },
      profile: "fastIdempotent" as const,
    };
    expect(helmInstall("api", "./chart", opts)).toEqual(helmInstallOld("api", "./chart", opts));
  });

  test("helmInstallPinned: identical ActivityStep to core's original", () => {
    const opts = { namespace: "prod" };
    expect(helmInstallPinned("api", "sha256:abc", opts)).toEqual(helmInstallPinnedOld("api", "sha256:abc", opts));
  });

  test("helmInstall: accepts a StepOutputRef in a typed slot", () => {
    const ref = stepOutput("render-step", "namespace");
    const step = helmInstall("api", "./chart", { namespace: ref });
    expect(step.args?.namespace).toBe(ref);
  });

  test("helmInstall: .out is reachable when an id is given", () => {
    const step = helmInstall("api", "./chart", { id: "deploy" });
    const ref: StepOutputRef = step.out.releaseName;
    expect(ref.step).toBe("deploy");
    expect(ref.path).toBe("releaseName");
  });
});

// ── Compile-time-only: authoring-time type errors (never executed) ──────────
function _typeChecksOnly(): void {
  // @ts-expect-error — "nameSpace" is not a key of HelmInstallArgs (the exact
  // typo class chant #1288 names: helmInstall("api", "./chart", { nameSpace:
  // "prod" }) silently no-opped before this).
  helmInstall("api", "./chart", { nameSpace: "prod" });

  // @ts-expect-error — set's values must be strings, not numbers.
  helmInstall("api", "./chart", { set: { replicas: 3 } });

  // @ts-expect-error — overrideProfileAssertion must be boolean.
  helmInstall("api", "./chart", { overrideProfileAssertion: "true" });

  // @ts-expect-error — contentDigest must be a string (the `sha256:...`
  // digest), not a number.
  helmInstall("api", "./chart", { contentDigest: 5 });
}
void _typeChecksOnly;
