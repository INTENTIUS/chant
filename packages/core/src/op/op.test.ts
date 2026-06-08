/**
 * Core Op builder tests.
 */

import { describe, expect, it } from "vitest";
import { Op, phase, activity, gate, build, kubectlApply, helmInstall,
         waitForStack, gitlabPipeline, lifecycleSnapshot, shell, teardown, policyGate } from "./builders";
import { DECLARABLE_MARKER, type Declarable } from "../declarable";

// ── Op() ──────────────────────────────────────────────────────────────────────

describe("Op()", () => {
  function opProps(op: Declarable): Record<string, unknown> {
    return (op as unknown as { props: Record<string, unknown> }).props;
  }

  it("returns a Declarable with correct lexicon and entityType", () => {
    const op = Op({ name: "my-op", overview: "Test op", phases: [] });
    expect(op[DECLARABLE_MARKER]).toBe(true);
    expect(op.lexicon).toBe("temporal");
    expect(op.entityType).toBe("Temporal::Op");
    expect(op.kind).toBe("resource");
  });

  it("stores name and overview in props", () => {
    const op = Op({ name: "deploy-op", overview: "Deploy infra", phases: [] });
    const props = opProps(op);
    expect(props.name).toBe("deploy-op");
    expect(props.overview).toBe("Deploy infra");
  });

  it("stores phases in props", () => {
    const p = phase("Build", [build("path/to/project")]);
    const op = Op({ name: "op", overview: "o", phases: [p] });
    const props = opProps(op);
    expect(Array.isArray(props.phases)).toBe(true);
    expect((props.phases as unknown[]).length).toBe(1);
  });

  it("stores optional depends in props", () => {
    const op = Op({ name: "second-op", overview: "o", phases: [], depends: ["first-op"] });
    const props = opProps(op);
    expect(props.depends).toEqual(["first-op"]);
  });

  it("stores optional onFailure in props", () => {
    const compensation = phase("Rollback", [shell("echo rollback")]);
    const op = Op({ name: "op", overview: "o", phases: [], onFailure: [compensation] });
    const props = opProps(op);
    expect(Array.isArray(props.onFailure)).toBe(true);
  });

  it("stores optional taskQueue in props", () => {
    const op = Op({ name: "op", overview: "o", phases: [], taskQueue: "custom-queue" });
    const props = opProps(op);
    expect(props.taskQueue).toBe("custom-queue");
  });
});

// ── phase() ───────────────────────────────────────────────────────────────────

describe("phase()", () => {
  it("returns correct shape with name and steps", () => {
    const p = phase("Deploy", [build("./")]);
    expect(p.name).toBe("Deploy");
    expect(p.steps).toHaveLength(1);
  });

  it("sets parallel: true when passed as option", () => {
    const p = phase("Build", [build("a"), build("b")], { parallel: true });
    expect(p.parallel).toBe(true);
  });

  it("omits parallel key when not set", () => {
    const p = phase("Build", [build("a")]);
    expect("parallel" in p).toBe(false);
  });
});

// ── activity() ────────────────────────────────────────────────────────────────

describe("activity()", () => {
  it("returns ActivityStep with kind 'activity'", () => {
    const a = activity("myFn");
    expect(a.kind).toBe("activity");
    expect(a.fn).toBe("myFn");
  });

  it("includes args when provided", () => {
    const a = activity("myFn", { key: "val" });
    expect(a.args).toEqual({ key: "val" });
  });

  it("omits args key when no args provided", () => {
    const a = activity("myFn");
    expect("args" in a).toBe(false);
  });

  it("includes profile when provided", () => {
    const a = activity("myFn", {}, "longInfra");
    expect(a.profile).toBe("longInfra");
  });

  it("omits profile key when not provided", () => {
    const a = activity("myFn");
    expect("profile" in a).toBe(false);
  });
});

// ── gate() ────────────────────────────────────────────────────────────────────

describe("gate()", () => {
  it("returns GateStep with kind 'gate' and signalName", () => {
    const g = gate("dns-delegation");
    expect(g.kind).toBe("gate");
    expect(g.signalName).toBe("dns-delegation");
  });

  it("includes timeout when provided", () => {
    const g = gate("approval", { timeout: "24h" });
    expect(g.timeout).toBe("24h");
  });

  it("includes description when provided", () => {
    const g = gate("approval", { description: "Awaiting DNS delegation" });
    expect(g.description).toBe("Awaiting DNS delegation");
  });

  it("omits timeout and description when not provided", () => {
    const g = gate("sig");
    expect("timeout" in g).toBe(false);
    expect("description" in g).toBe(false);
  });
});

// ── Pre-built shortcuts ───────────────────────────────────────────────────────

describe("pre-built shortcuts", () => {
  it("build() produces chantBuild activity with path arg", () => {
    const a = build("./my-project");
    expect(a.kind).toBe("activity");
    expect(a.fn).toBe("chantBuild");
    expect(a.args?.path).toBe("./my-project");
  });

  it("build() uses default fastIdempotent profile (no profile key)", () => {
    const a = build("./p");
    expect("profile" in a).toBe(false);
  });

  it("kubectlApply() produces kubectlApply activity with longInfra profile", () => {
    const a = kubectlApply("dist/infra.yaml");
    expect(a.fn).toBe("kubectlApply");
    expect(a.args?.manifest).toBe("dist/infra.yaml");
    expect(a.profile).toBe("longInfra");
  });

  it("helmInstall() produces helmInstall activity with name and chart", () => {
    const a = helmInstall("my-release", "charts/app");
    expect(a.fn).toBe("helmInstall");
    expect(a.args?.name).toBe("my-release");
    expect(a.args?.chart).toBe("charts/app");
    expect(a.profile).toBe("longInfra");
  });

  it("waitForStack() produces waitForStack activity with k8sWait profile", () => {
    const a = waitForStack("my-stack");
    expect(a.fn).toBe("waitForStack");
    expect(a.args?.name).toBe("my-stack");
    expect(a.profile).toBe("k8sWait");
  });

  it("gitlabPipeline() produces gitlabPipeline activity with longInfra profile", () => {
    const a = gitlabPipeline("group/project");
    expect(a.fn).toBe("gitlabPipeline");
    expect(a.args?.name).toBe("group/project");
    expect(a.profile).toBe("longInfra");
  });

  it("lifecycleSnapshot() produces lifecycleSnapshot activity with env arg", () => {
    const a = lifecycleSnapshot("prod");
    expect(a.fn).toBe("lifecycleSnapshot");
    expect(a.args?.env).toBe("prod");
    expect("profile" in a).toBe(false);
  });

  it("shell() produces shellCmd activity with cmd arg", () => {
    const a = shell("echo hello");
    expect(a.fn).toBe("shellCmd");
    expect(a.args?.cmd).toBe("echo hello");
  });

  it("teardown() produces chantTeardown activity with longInfra profile", () => {
    const a = teardown("./project");
    expect(a.fn).toBe("chantTeardown");
    expect(a.args?.path).toBe("./project");
    expect(a.profile).toBe("longInfra");
  });

  it("policyGate() produces a policyGate activity with the single-attempt policyCheck profile", () => {
    const a = policyGate({ env: "prod" });
    expect(a.fn).toBe("policyGate");
    expect(a.args?.path).toBe("."); // defaults to the project dir
    expect(a.args?.env).toBe("prod");
    expect(a.profile).toBe("policyCheck");
  });

  it("policyGate() with no opts defaults path to '.' and omits env", () => {
    const a = policyGate();
    expect(a.args?.path).toBe(".");
    expect("env" in (a.args ?? {})).toBe(false);
  });
});

describe("profile routing (opts.profile sets the step profile, never leaks into args)", () => {
  it("shell() routes profile to the step, keeps env in args", () => {
    const a = shell("docker compose push", { env: { TAG: "v1" }, profile: "longInfra" });
    expect(a.profile).toBe("longInfra");
    expect(a.args?.cmd).toBe("docker compose push");
    expect(a.args?.env).toEqual({ TAG: "v1" });
    // The footgun this fixes: profile must NOT end up as an activity arg.
    expect("profile" in (a.args ?? {})).toBe(false);
  });

  it("shell() without profile leaves the step unprofiled (defaults apply downstream)", () => {
    const a = shell("echo hi", { env: { A: "1" } });
    expect("profile" in a).toBe(false);
    expect(a.args?.env).toEqual({ A: "1" });
  });

  it("build() accepts a profile override and does not leak it into args", () => {
    const a = build("./p", { profile: "longInfra" });
    expect(a.profile).toBe("longInfra");
    expect(a.args?.path).toBe("./p");
    expect("profile" in (a.args ?? {})).toBe(false);
  });

  it("kubectlApply() lets opts.profile override the longInfra default", () => {
    const a = kubectlApply("dist/infra.yaml", { profile: "k8sWait" });
    expect(a.profile).toBe("k8sWait");
    expect(a.args?.manifest).toBe("dist/infra.yaml");
    expect("profile" in (a.args ?? {})).toBe(false);
  });

  it("waitForStack() supports the argoSync profile", () => {
    const a = waitForStack("argo-app", { profile: "argoSync" });
    expect(a.profile).toBe("argoSync");
    expect("profile" in (a.args ?? {})).toBe(false);
  });
});
