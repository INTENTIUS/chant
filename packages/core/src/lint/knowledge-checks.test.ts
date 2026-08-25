import { describe, test, expect } from "vitest";
import { coreKnowledgeChecks, STALE_KNOWLEDGE_BINDING_CHECK_ID } from "./knowledge-checks";
import { runPostSynthChecks } from "./post-synth";
import { DECLARABLE_MARKER, type Declarable } from "../declarable";
import type { OkfBundle, OkfConcept } from "../okf-read";

function entity(): Declarable {
  return { [DECLARABLE_MARKER]: true, lexicon: "aws", entityType: "AWS::S3::Bucket" } as unknown as Declarable;
}

function concept(overrides: Partial<OkfConcept> = {}): OkfConcept {
  return {
    path: "decisions/example.md",
    type: "decision",
    binds: [],
    frontmatter: {},
    body: "",
    ...overrides,
  };
}

function run(bundle: OkfBundle, entities: Map<string, Declarable>) {
  return runPostSynthChecks(coreKnowledgeChecks(bundle), {
    outputs: new Map(),
    entities,
    warnings: [],
    errors: [],
    sourceFileCount: 1,
  });
}

describe("COR026: stale knowledge binding (#1865)", () => {
  test("check id", () => {
    expect(STALE_KNOWLEDGE_BINDING_CHECK_ID).toBe("COR026");
    expect(coreKnowledgeChecks({ concepts: [] }).map((c) => c.id)).toContain("COR026");
  });

  test("fires once per unresolved binding, naming the concept path and the unresolved name", () => {
    const bundle: OkfBundle = {
      concepts: [concept({ path: "decisions/ghost.md", title: "Stale", binds: ["ghostBucket"] })],
    };
    const diags = run(bundle, new Map());
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("COR026");
    expect(diags[0].severity).toBe("warning");
    expect(diags[0].message).toContain("decisions/ghost.md");
    expect(diags[0].message).toContain("ghostBucket");
  });

  test("fires one diagnostic per unresolved name when a concept binds several", () => {
    const bundle: OkfBundle = {
      concepts: [concept({ binds: ["ghostOne", "ghostTwo"] })],
    };
    const diags = run(bundle, new Map());
    expect(diags).toHaveLength(2);
    expect(diags.map((d) => d.message).join("\n")).toContain("ghostOne");
    expect(diags.map((d) => d.message).join("\n")).toContain("ghostTwo");
  });

  test("does not fire when the bound name resolves to a discovered entity", () => {
    const bundle: OkfBundle = { concepts: [concept({ binds: ["realBucket"] })] };
    const entities = new Map<string, Declarable>([["realBucket", entity()]]);
    expect(run(bundle, entities)).toHaveLength(0);
  });

  test("does not fire for a concept with no binds at all — orphaned knowledge is legitimate", () => {
    const bundle: OkfBundle = { concepts: [concept({ binds: [] })] };
    expect(run(bundle, new Map())).toHaveLength(0);
  });

  test("does not fire for an empty bundle (no knowledge directory)", () => {
    expect(run({ concepts: [] }, new Map())).toHaveLength(0);
  });

  test("build and synthesis are unaffected — severity is always warning, never error", () => {
    const bundle: OkfBundle = { concepts: [concept({ binds: ["ghost"] })] };
    const diags = run(bundle, new Map());
    expect(diags.every((d) => d.severity === "warning")).toBe(true);
  });
});
