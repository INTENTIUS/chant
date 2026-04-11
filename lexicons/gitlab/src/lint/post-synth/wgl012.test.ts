import { describe, test, expect } from "vitest";
import { DECLARABLE_MARKER, type Declarable } from "@intentius/chant/declarable";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { wgl012, checkDeprecatedProperties } from "./wgl012";

class MockEntity implements Declarable {
  readonly [DECLARABLE_MARKER] = true as const;
  readonly lexicon = "gitlab";
  readonly entityType: string;
  readonly kind = "resource" as const;
  readonly props: Record<string, unknown>;

  constructor(entityType: string, props: Record<string, unknown> = {}) {
    this.entityType = entityType;
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

/** Synthetic deprecated-property map — no disk dependency. */
function fakeDeprecated(): Map<string, Set<string>> {
  return new Map([
    ["GitLab::CI::Job", new Set(["only", "except"])],
    ["GitLab::CI::Artifacts", new Set(["license_management"])],
  ]);
}

describe("WGL012: Deprecated Property Usage", () => {
  test("check metadata", () => {
    expect(wgl012.id).toBe("WGL012");
    expect(wgl012.description).toContain("Deprecated");
  });

  test("emits warning for deprecated property", () => {
    const entities = new Map<string, Declarable>([
      ["deployJob", new MockEntity("GitLab::CI::Job", {
        only: ["main"],
        script: ["deploy.sh"],
      })],
    ]);
    const diags = checkDeprecatedProperties(makeCtx(entities), fakeDeprecated());
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("WGL012");
    expect(diags[0].severity).toBe("warning");
    expect(diags[0].message).toContain("only");
    expect(diags[0].message).toContain("deployJob");
    expect(diags[0].message).toContain("deprecated");
    expect(diags[0].entity).toBe("deployJob");
    expect(diags[0].lexicon).toBe("gitlab");
  });

  test("emits one warning per deprecated property", () => {
    const entities = new Map<string, Declarable>([
      ["oldJob", new MockEntity("GitLab::CI::Job", {
        only: ["main"],
        except: ["tags"],
        script: ["test"],
      })],
    ]);
    const diags = checkDeprecatedProperties(makeCtx(entities), fakeDeprecated());
    expect(diags).toHaveLength(2);
    expect(diags.some((d) => d.message.includes("only"))).toBe(true);
    expect(diags.some((d) => d.message.includes("except"))).toBe(true);
  });

  test("no diagnostic for non-deprecated properties", () => {
    const entities = new Map<string, Declarable>([
      ["testJob", new MockEntity("GitLab::CI::Job", {
        script: ["npm test"],
        stage: "test",
      })],
    ]);
    const diags = checkDeprecatedProperties(makeCtx(entities), fakeDeprecated());
    expect(diags).toHaveLength(0);
  });

  test("no diagnostic for entity type not in map", () => {
    const entities = new Map<string, Declarable>([
      ["myCache", new MockEntity("GitLab::CI::Cache", {
        paths: ["node_modules/"],
      })],
    ]);
    const diags = checkDeprecatedProperties(makeCtx(entities), fakeDeprecated());
    expect(diags).toHaveLength(0);
  });

  test("no diagnostic on empty entities", () => {
    const diags = checkDeprecatedProperties(makeCtx(new Map()), fakeDeprecated());
    expect(diags).toHaveLength(0);
  });

  test("returns empty when deprecated map is empty", () => {
    const entities = new Map<string, Declarable>([
      ["job", new MockEntity("GitLab::CI::Job", { only: ["main"] })],
    ]);
    const diags = checkDeprecatedProperties(makeCtx(entities), new Map());
    expect(diags).toHaveLength(0);
  });

  test("flags deprecated properties across multiple entities", () => {
    const entities = new Map<string, Declarable>([
      ["oldJob", new MockEntity("GitLab::CI::Job", { only: ["main"], script: ["test"] })],
      ["artifacts", new MockEntity("GitLab::CI::Artifacts", { license_management: "report.json" })],
    ]);
    const diags = checkDeprecatedProperties(makeCtx(entities), fakeDeprecated());
    expect(diags).toHaveLength(2);
    expect(diags[0].entity).toBe("oldJob");
    expect(diags[1].entity).toBe("artifacts");
  });

  test("handles entity with no props", () => {
    const entities = new Map<string, Declarable>([
      ["emptyJob", new MockEntity("GitLab::CI::Job")],
    ]);
    const diags = checkDeprecatedProperties(makeCtx(entities), fakeDeprecated());
    expect(diags).toHaveLength(0);
  });
});
