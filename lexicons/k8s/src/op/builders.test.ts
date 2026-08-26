/**
 * Typed step-builder wrappers (chant #1288 Stage 2). Two things asserted:
 *
 *  - **Backward compat**: for every input core's original untyped builder
 *    accepted, the new typed twin here produces a byte-identical
 *    `ActivityStep` (own enumerable fields — `.out` is a non-enumerable
 *    getter on both, per `builders.ts`'s `activity()`, so `toEqual` never
 *    sees it). Same construction path (`activity()` + `takeProfileAndId`),
 *    so this is really asserting the two call sites agree, not re-deriving
 *    the logic.
 *  - **Step-output refs compose**: a {@link StepOutputRef} in a typed slot
 *    type-checks and lands in the step's `args` untouched (chant #1950).
 *
 * The `@ts-expect-error` block at the bottom is a compile-time-only check —
 * never executed, just walked by `npm run typecheck` (tsc), which fails if a
 * marked line does NOT error (an "unused '@ts-expect-error' directive").
 */

import { describe, test, expect } from "vitest";
import {
  kubectlApply as kubectlApplyOld,
  waitForReady as waitForReadyOld,
  ensureSecret as ensureSecretOld,
  stepOutput,
  type StepOutputRef,
} from "@intentius/chant/op";
import { kubectlApply, waitForReady, ensureSecret } from "./builders";

describe("k8s typed step builders (#1288 Stage 2)", () => {
  test("kubectlApply: identical ActivityStep to core's original for a minimal call", () => {
    expect(kubectlApply("dist/k8s.yaml")).toEqual(kubectlApplyOld("dist/k8s.yaml"));
  });

  test("kubectlApply: identical ActivityStep with opts (profile override, force, deleteMode)", () => {
    const opts = { context: "kind-dev", force: true, deleteMode: "owned-only" as const, profile: "fastIdempotent" as const };
    expect(kubectlApply("dist/k8s.yaml", opts)).toEqual(kubectlApplyOld("dist/k8s.yaml", opts));
  });

  test("kubectlApply: accepts a StepOutputRef in a typed slot", () => {
    const ref = stepOutput("build-step", "manifestPath");
    const step = kubectlApply("dist/k8s.yaml", { context: ref });
    expect(step.args?.context).toBe(ref);
  });

  test("waitForReady: identical ActivityStep to core's original", () => {
    const opts = { namespace: "prod", intervalMs: 5000 };
    expect(waitForReady("certificate", "my-cert", opts)).toEqual(waitForReadyOld("certificate", "my-cert", opts));
  });

  test("ensureSecret: identical ActivityStep to core's original", () => {
    const opts = { metadata: { team: "platform" } };
    expect(ensureSecret("db-creds", ["password"], opts)).toEqual(ensureSecretOld("db-creds", ["password"], opts));
  });

  test("kubectlApply: .out is reachable when an id is given", () => {
    const step = kubectlApply("dist/k8s.yaml", { id: "apply" });
    const ref: StepOutputRef = step.out.fieldManager;
    expect(ref.step).toBe("apply");
    expect(ref.path).toBe("fieldManager");
  });
});

// ── Compile-time-only: authoring-time type errors (never executed) ──────────
function _typeChecksOnly(): void {
  // @ts-expect-error — "nameSpace" is not a key of KubectlApplyArgs (the
  // exact typo class chant #1288 names: helmInstall("api", "./chart", {
  // nameSpace: "prod" }) silently no-opped before this).
  kubectlApply("dist/k8s.yaml", { nameSpace: "prod" });

  // @ts-expect-error — deleteMode must be one of ApplyDeleteMode's literals.
  kubectlApply("dist/k8s.yaml", { deleteMode: "always" });

  // @ts-expect-error — force must be boolean, not a string.
  kubectlApply("dist/k8s.yaml", { force: "yes" });

  // @ts-expect-error — waitForReady's readiness spec field is misspelled.
  waitForReady("certificate", "my-cert", { specc: {} });

  // @ts-expect-error — ensureSecret's keys must be string[], not a single string.
  ensureSecret("db-creds", "password");
}
void _typeChecksOnly;
