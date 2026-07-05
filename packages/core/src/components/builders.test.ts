import { describe, test, expect } from "vitest";
import { phase, projectToJson, type Component } from "./component";
import { dockerBuild, jvmBuild, healthGate, waitEndpoint, waitClusterHealthy } from "./builders";

describe("step builders (#658)", () => {
  test("a step builder tags its input with the verb kind", () => {
    expect(healthGate({ path: "/healthz" })).toEqual({ kind: "health-gate", path: "/healthz" });
    expect(waitEndpoint({ url: "http://x/health" })).toEqual({ kind: "wait-endpoint", url: "http://x/health" });
    expect(waitClusterHealthy({ cluster: "h:7687", size: 1 })).toEqual({
      kind: "wait-cluster-healthy",
      cluster: "h:7687",
      size: 1,
    });
  });

  test("build-family builders produce a BuildSpec (for the `build` field)", () => {
    expect(dockerBuild({ context: ".", into: "archive" })).toEqual({
      kind: "docker-build",
      context: ".",
      into: "archive",
    });
    expect(jvmBuild({ tool: "maven", path: ".", into: "archive" })).toEqual({
      kind: "jvm-build",
      tool: "maven",
      path: ".",
      into: "archive",
    });
  });

  test("a component authored with builders projects identically to kind-literals", () => {
    const built: Component = {
      name: "svc",
      dependsOn: [],
      build: dockerBuild({ context: ".", into: "archive" }),
      deploy: [phase("Verify", [healthGate({ path: "/healthz" })])],
    };
    const literal: Component = {
      name: "svc",
      dependsOn: [],
      build: { kind: "docker-build", context: ".", into: "archive" },
      deploy: [phase("Verify", [{ kind: "health-gate", path: "/healthz" }])],
    };
    expect(projectToJson(built)).toEqual(projectToJson(literal));
  });
});
