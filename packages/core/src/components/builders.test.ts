import { describe, test, expect } from "vitest";
import { phase, projectToJson, type Component } from "./component";
import {
  dockerBuild,
  jvmBuild,
  publishImage,
  publishArtifact,
  publishAsset,
  cfnDeploy,
  healthGate,
  waitJob,
} from "./builders";

describe("step builders (#658)", () => {
  test("a step builder tags its input with the verb kind", () => {
    expect(publishImage({ from: "archive", to: "$env.registry" })).toEqual({
      kind: "publish-image",
      from: "archive",
      to: "$env.registry",
    });
    expect(cfnDeploy({ template: "archive:t.json", imageRef: "@Publish.digest" })).toEqual({
      kind: "cfn-deploy",
      template: "archive:t.json",
      imageRef: "@Publish.digest",
    });
    expect(healthGate({ path: "/healthz" })).toEqual({ kind: "health-gate", path: "/healthz" });
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

  test("publishAsset is an alias of publishArtifact (same publish-artifact kind)", () => {
    expect(publishAsset).toBe(publishArtifact);
    expect(publishAsset({ from: "archive", to: "$env.s3" })).toEqual({
      kind: "publish-artifact",
      from: "archive",
      to: "$env.s3",
    });
  });

  test("a component authored with builders projects identically to kind-literals", () => {
    const built: Component = {
      name: "svc",
      dependsOn: [],
      build: dockerBuild({ context: ".", into: "archive" }),
      deploy: [
        phase("Publish", [publishImage({ from: "archive", to: "$env.registry" })]),
        phase("Apply", [cfnDeploy({ template: "archive:t.json", imageRef: "@Publish.digest" })]),
        phase("Verify", [waitJob({ runId: "@Apply.runId" })]),
      ],
    };
    const literal: Component = {
      name: "svc",
      dependsOn: [],
      build: { kind: "docker-build", context: ".", into: "archive" },
      deploy: [
        phase("Publish", [{ kind: "publish-image", from: "archive", to: "$env.registry" }]),
        phase("Apply", [{ kind: "cfn-deploy", template: "archive:t.json", imageRef: "@Publish.digest" }]),
        phase("Verify", [{ kind: "wait-job", runId: "@Apply.runId" }]),
      ],
    };
    expect(projectToJson(built)).toEqual(projectToJson(literal));
  });
});
