import { describe, test, expect } from "vitest";
import {
  pipelineSupplyChainAudit,
  collectPipelineRefs,
  type PipelineRefResolution,
  type GitlabRefResolver,
} from "./pipeline-audit";

const PIPELINE = `include:
  - project: my-group/ci-templates
    ref: v1.2.3
    file: /build.yml
  - component: gitlab.example.com/my-group/my-comp@1.0.0

build:
  image:
    name: node:20
  script:
    - npm ci
`;

function recordedResolver(records: Record<string, PipelineRefResolution>): GitlabRefResolver {
  return async (kind, identifier, ref) =>
    records[`${kind}:${identifier}@${ref}`] ?? { exists: true, archived: false, advisories: [] };
}

describe("collectPipelineRefs (#303)", () => {
  test("collects include:project, component, and image refs", () => {
    const refs = collectPipelineRefs(PIPELINE);
    const ids = refs.map((r) => `${r.refKind}:${r.identifier}`);
    expect(ids).toContain("include:my-group/ci-templates");
    expect(ids).toContain("component:gitlab.example.com/my-group/my-comp");
    expect(ids).toContain("image:node:20");
    expect(refs.find((r) => r.refKind === "include")?.ref).toBe("v1.2.3");
    expect(refs.find((r) => r.refKind === "component")?.ref).toBe("1.0.0");
  });

  test("skips variable-based images", () => {
    const refs = collectPipelineRefs(`build:\n  image:\n    name: $CI_REGISTRY_IMAGE:latest\n`);
    expect(refs.filter((r) => r.refKind === "image")).toHaveLength(0);
  });
});

describe("pipelineSupplyChainAudit (#303)", () => {
  test("flags unresolved, archived, and moved references", async () => {
    const resolver = recordedResolver({
      "include:my-group/ci-templates@v1.2.3": { exists: true, archived: true, advisories: [] },
      "component:gitlab.example.com/my-group/my-comp@1.0.0": { exists: false, archived: false, advisories: [] },
      "image:node:20@20": { exists: true, archived: false, advisories: ["GHSA-img"], movedTo: undefined },
    });
    const result = await pipelineSupplyChainAudit({ yaml: PIPELINE, resolver, mode: "merge-request" });
    const kinds = result.findings.map((f) => `${f.identifier}:${f.kind}`);

    expect(kinds).toContain("my-group/ci-templates:archived");
    expect(kinds).toContain("gitlab.example.com/my-group/my-comp:unresolved");
    expect(kinds).toContain("node:20:advisory");
    expect(result.mode).toBe("merge-request");
    expect(result.summary).toContain("Pipeline include/component audit");
  });

  test("clean pipeline yields no findings", async () => {
    const resolver = recordedResolver({});
    const result = await pipelineSupplyChainAudit({ yaml: PIPELINE, resolver });
    expect(result.findings).toHaveLength(0);
    expect(result.summary).toContain("No live drift");
  });
});
