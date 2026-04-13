/**
 * Core Op builder tests.
 */

import { describe, expect, it } from "vitest";
import { Op, phase, activity, gate, build, kubectlApply, helmInstall,
         waitForStack, gitlabPipeline, stateSnapshot, shell, teardown } from "./builders";
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

  it("stateSnapshot() produces stateSnapshot activity with env arg", () => {
    const a = stateSnapshot("prod");
    expect(a.fn).toBe("stateSnapshot");
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
});
