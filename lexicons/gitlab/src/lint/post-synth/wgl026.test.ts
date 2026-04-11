import { describe, test, expect } from "vitest";
import { DECLARABLE_MARKER, type Declarable } from "@intentius/chant/declarable";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { wgl026 } from "./wgl026";

class MockJob implements Declarable {
  readonly [DECLARABLE_MARKER] = true as const;
  readonly lexicon = "gitlab";
  readonly entityType = "GitLab::CI::Job";
  readonly kind = "resource" as const;
  readonly props: Record<string, unknown>;

  constructor(props: Record<string, unknown> = {}) {
    this.props = props;
  }
}

function makeCtx(entities: Map<string, Declarable>): PostSynthContext {
  return {
    outputs: new Map(),
    entities,
    buildResult: {
      outputs: new Map(),
      entities,
      warnings: [],
      errors: [],
      sourceFileCount: 1,
    },
  };
}

describe("WGL026: Privileged Services Without TLS", () => {
  test("check metadata", () => {
    expect(wgl026.id).toBe("WGL026");
    expect(wgl026.description).toContain("TLS");
  });

  test("flags DinD service without TLS cert dir", () => {
    const entities = new Map<string, Declarable>([
      ["buildImage", new MockJob({
        script: ["docker build ."],
        services: [{ name: "docker:dind" }],
      })],
    ]);
    const diags = wgl026.check(makeCtx(entities));
    expect(diags).toHaveLength(1);
    expect(diags[0].severity).toBe("warning");
    expect(diags[0].message).toContain("buildImage");
    expect(diags[0].message).toContain("TLS");
  });

  test("does not flag DinD service with TLS cert dir in job variables", () => {
    const entities = new Map<string, Declarable>([
      ["buildImage", new MockJob({
        script: ["docker build ."],
        services: [{ name: "docker:dind" }],
        variables: { DOCKER_TLS_CERTDIR: "/certs" },
      })],
    ]);
    const diags = wgl026.check(makeCtx(entities));
    expect(diags).toHaveLength(0);
  });

  test("does not flag non-DinD service", () => {
    const entities = new Map<string, Declarable>([
      ["testJob", new MockJob({
        script: ["npm test"],
        services: [{ name: "postgres:15" }],
      })],
    ]);
    const diags = wgl026.check(makeCtx(entities));
    expect(diags).toHaveLength(0);
  });

  test("does not flag job without services", () => {
    const entities = new Map<string, Declarable>([
      ["simpleJob", new MockJob({ script: ["test"] })],
    ]);
    const diags = wgl026.check(makeCtx(entities));
    expect(diags).toHaveLength(0);
  });

  test("no diagnostics on empty entities", () => {
    const diags = wgl026.check(makeCtx(new Map()));
    expect(diags).toHaveLength(0);
  });
});
