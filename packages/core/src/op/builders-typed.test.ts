/**
 * The typed step-builder wrappers over core's own base activities (chant #1288
 * Stage 2, moved here from the temporal lexicon by #2114). `opts` in each is
 * the activity's own `*Args` interface (`./activities/*.ts`) via `Omit`/
 * `WithStepRefs`, never a hand-restated mirror, so a signature change in the
 * activity is a compile error at the builder rather than a silently-dropped arg.
 *
 * These are asserted against the `ActivityStep` they emit — the fixed profiles
 * (`policyGate`/`guardValidate` on `policyCheck`, `teardown` on `longInfra`)
 * and defaults (`waitForStack` → `k8sWait`, `httpCheck`/`envTeardown`) are
 * pinned here, since there is no longer a second, untyped implementation to
 * compare against.
 */

import { describe, test, expect } from "vitest";
import {
  build,
  shell,
  waitForStack,
  lifecycleSnapshot,
  teardown,
  envTeardown,
  httpCheck,
  policyGate,
  guardValidate,
  stepOutput,
  type StepOutputRef,
} from "./index";

describe("typed step builders over the base activities", () => {
  test("build: names chantBuild, path is positional, opts spread into args", () => {
    expect(build("examples/gitlab-aws-alb-infra")).toMatchObject({
      kind: "activity",
      fn: "chantBuild",
      args: { path: "examples/gitlab-aws-alb-infra" },
    });
    expect(build(".", { script: "build:aws", env: { NODE_ENV: "production" } })).toMatchObject({
      fn: "chantBuild",
      args: { path: ".", script: "build:aws", env: { NODE_ENV: "production" } },
    });
  });

  test("shell: names shellCmd; env and profile route where they belong", () => {
    expect(shell("npm run db:seed")).toMatchObject({ fn: "shellCmd", args: { cmd: "npm run db:seed" } });
    const step = shell("docker push image", { env: { FOO: "bar" }, profile: "longInfra" });
    expect(step.args).toEqual({ cmd: "docker push image", env: { FOO: "bar" } });
    expect(step.profile).toBe("longInfra");
  });

  test("shell: cwd is reachable (the untyped builder this replaced dropped it)", () => {
    const step = shell("ls", { cwd: "/tmp" });
    expect(step.args?.cwd).toBe("/tmp");
  });

  test("waitForStack: defaults to the k8sWait profile", () => {
    const step = waitForStack("alb-api", { namespace: "alb" });
    expect(step).toMatchObject({ fn: "waitForStack", args: { name: "alb-api", namespace: "alb" } });
    expect(step.profile).toBe("k8sWait");
  });

  test("lifecycleSnapshot: env is the only arg", () => {
    expect(lifecycleSnapshot("staging")).toMatchObject({
      fn: "lifecycleSnapshot",
      args: { env: "staging" },
    });
  });

  test("lifecycleSnapshot: .out is reachable via an id", () => {
    const step = lifecycleSnapshot("staging", { id: "snap" });
    const ref: StepOutputRef = step.out.env;
    expect(ref.step).toBe("snap");
    expect(ref.path).toBe("env");
  });

  test("teardown: fixed longInfra profile", () => {
    const step = teardown("examples/getting-started");
    expect(step).toMatchObject({ fn: "chantTeardown", args: { path: "examples/getting-started" } });
    expect(step.profile).toBe("longInfra");
  });

  test("envTeardown: defaults to longInfra, confirmProd passes through", () => {
    const step = envTeardown("prod", { confirmProd: true });
    expect(step.args).toEqual({ env: "prod", confirmProd: true });
    expect(step.profile).toBe("longInfra");
  });

  test("httpCheck: defaults to fastIdempotent", () => {
    const step = httpCheck("https://example.com/health", { status: 200, contains: "ok" });
    expect(step.args).toEqual({ url: "https://example.com/health", status: 200, contains: "ok" });
    expect(step.profile).toBe("fastIdempotent");
  });

  test("policyGate: fixed policyCheck profile, path defaults to '.'", () => {
    expect(policyGate()).toMatchObject({ fn: "policyGate", args: { path: "." }, profile: "policyCheck" });
    expect(policyGate({ env: "staging" }).args).toEqual({ path: ".", env: "staging" });
  });

  test("waitForStack: accepts a StepOutputRef in a typed slot", () => {
    const ref = stepOutput("build-step", "namespace");
    const step = waitForStack("alb-api", { namespace: ref });
    expect(step.args?.namespace).toBe(ref);
  });

  test("guardValidate: builds an activity step naming the guardValidate activity", () => {
    const step = guardValidate("rules.guard");
    expect(step.kind).toBe("activity");
    expect(step.fn).toBe("guardValidate");
    expect(step.args).toEqual({ rules: "rules.guard" });
    expect(step.profile).toBe("policyCheck");
  });

  test("guardValidate: template/binary/onFinding pass through as args; id routes to the step, not args", () => {
    const step = guardValidate("rules.guard", { template: "dist/out.json", binary: "/opt/bin/cfn-guard", onFinding: "report", id: "guard" });
    expect(step.args).toEqual({
      rules: "rules.guard",
      template: "dist/out.json",
      binary: "/opt/bin/cfn-guard",
      onFinding: "report",
    });
    expect(step.id).toBe("guard");
    expect(step.profile).toBe("policyCheck");
  });

  test("guardValidate: .out is reachable once the step is given an id", () => {
    const step = guardValidate("rules.guard", { id: "guard" });
    const ref: StepOutputRef = step.out.findings;
    expect(ref.step).toBe("guard");
    expect(ref.path).toBe("findings");
  });

  test("guardValidate: accepts a StepOutputRef in a typed slot", () => {
    const ref = stepOutput("build-step", "outPath");
    const step = guardValidate("rules.guard", { template: ref });
    expect(step.args?.template).toBe(ref);
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
  // policyCheck, single-attempt).
  policyGate({ profile: "fastIdempotent" });

  // @ts-expect-error — guardValidate has no `profile` override either
  // (fixed to policyCheck, same reasoning as policyGate).
  guardValidate("rules.guard", { profile: "fastIdempotent" });

  // @ts-expect-error — onFinding only admits "report" today (#522 leaves
  // issue/pull-request modes to a follow-up).
  guardValidate("rules.guard", { onFinding: "issue" });
}
void _typeChecksOnly;
