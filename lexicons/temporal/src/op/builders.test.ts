/**
 * Typed step-builder wrappers for this lexicon's own activities (chant #1288
 * Stage 2). Unlike the k8s/helm/gitlab typed wrappers, these REPLACE the
 * entries `src/index.ts` used to re-export from `@intentius/chant/op` — same
 * name, same import path — so the backward-compat assertion here is doubly
 * important: every existing `import { build, waitForStack, ... } from
 * "@intentius/chant-lexicon-temporal"` call site must see byte-identical
 * `ActivityStep` output for inputs it already used.
 */

import { describe, test, expect } from "vitest";
import {
  build as buildOld,
  shell as shellOld,
  waitForStack as waitForStackOld,
  lifecycleSnapshot as lifecycleSnapshotOld,
  teardown as teardownOld,
  envTeardown as envTeardownOld,
  httpCheck as httpCheckOld,
  policyGate as policyGateOld,
  stepOutput,
  type StepOutputRef,
} from "@intentius/chant/op";
import { build, shell, waitForStack, lifecycleSnapshot, teardown, envTeardown, httpCheck, policyGate } from "./builders";

describe("temporal typed step builders (#1288 Stage 2)", () => {
  test("build: identical ActivityStep to core's original", () => {
    expect(build("examples/gitlab-aws-alb-infra")).toEqual(buildOld("examples/gitlab-aws-alb-infra"));
    const opts = { script: "build:aws", env: { NODE_ENV: "production" } };
    expect(build(".", opts)).toEqual(buildOld(".", opts));
  });

  test("shell: identical ActivityStep to core's original for the fields it supported (cmd, env, profile)", () => {
    expect(shell("npm run db:seed")).toEqual(shellOld("npm run db:seed"));
    const opts = { env: { FOO: "bar" }, profile: "longInfra" as const };
    expect(shell("docker push image", opts)).toEqual(shellOld("docker push image", opts));
  });

  test("shell: cwd is now reachable (core's original untyped builder dropped it)", () => {
    const step = shell("ls", { cwd: "/tmp" });
    expect(step.args?.cwd).toBe("/tmp");
  });

  test("waitForStack: identical ActivityStep to core's original", () => {
    const opts = { namespace: "alb" };
    expect(waitForStack("alb-api", opts)).toEqual(waitForStackOld("alb-api", opts));
  });

  test("lifecycleSnapshot: identical ActivityStep to core's original", () => {
    expect(lifecycleSnapshot("staging")).toEqual(lifecycleSnapshotOld("staging"));
  });

  test("lifecycleSnapshot: .out is now reachable via an id (core's original had no way to name this step)", () => {
    const step = lifecycleSnapshot("staging", { id: "snap" });
    const ref: StepOutputRef = step.out.env;
    expect(ref.step).toBe("snap");
    expect(ref.path).toBe("env");
  });

  test("teardown: identical ActivityStep to core's original (fixed longInfra profile)", () => {
    expect(teardown("examples/getting-started")).toEqual(teardownOld("examples/getting-started"));
  });

  test("envTeardown: identical ActivityStep to core's original", () => {
    const opts = { confirmProd: true };
    expect(envTeardown("prod", opts)).toEqual(envTeardownOld("prod", opts));
  });

  test("httpCheck: identical ActivityStep to core's original", () => {
    const opts = { status: 200, contains: "ok" };
    expect(httpCheck("https://example.com/health", opts)).toEqual(httpCheckOld("https://example.com/health", opts));
  });

  test("policyGate: identical ActivityStep to core's original (fixed policyCheck profile, path defaults to '.')", () => {
    expect(policyGate()).toEqual(policyGateOld());
    expect(policyGate({ env: "staging" })).toEqual(policyGateOld({ env: "staging" }));
  });

  test("waitForStack: accepts a StepOutputRef in a typed slot", () => {
    const ref = stepOutput("build-step", "namespace");
    const step = waitForStack("alb-api", { namespace: ref });
    expect(step.args?.namespace).toBe(ref);
  });
});

// ── Compile-time-only: authoring-time type errors (never executed) ──────────
function _typeChecksOnly(): void {
  // @ts-expect-error — "environment" is not a key of ChantBuildArgs (the
  // exact typo class chant #1288 names: `env` is the field, not
  // `environment` — e.g. activity("lifecycleDiff", { environment: "prod" })
  // silently ignored the whole arg before this).
  build(".", { environment: "prod" });

  // @ts-expect-error — waitForStack's intervalMs must be a number.
  waitForStack("alb-api", { intervalMs: "5000" });

  // @ts-expect-error — httpCheck's status must be a number.
  httpCheck("https://example.com", { status: "200" });

  // @ts-expect-error — policyGate has no `profile` override (fixed to
  // policyCheck, single-attempt, exactly as core's original).
  policyGate({ profile: "fastIdempotent" });
}
void _typeChecksOnly;
