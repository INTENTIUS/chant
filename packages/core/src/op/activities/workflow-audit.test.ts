import { describe, test, expect } from "vitest";
import {
  workflowSupplyChainAudit,
  collectAuditRefs,
  type ActionRefResolution,
  type ActionRefResolver,
} from "./workflow-audit";

const SHA = "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b";

const WORKFLOW = `name: CI
on:
  push:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@${SHA} # v4.1.0
      - uses: evil/typo-action@v1
      - uses: archived/old-action@v2
`;

/** Recorded upstream responses — no live network. */
function recordedResolver(records: Record<string, ActionRefResolution>): ActionRefResolver {
  return async (slug, ref) =>
    records[`${slug}@${ref}`] ?? { exists: true, tags: [], archived: false, advisories: [] };
}

describe("collectAuditRefs (#292)", () => {
  test("collects external refs with version comments, skipping local/docker", () => {
    const yaml = `jobs:
  a:
    steps:
      - uses: actions/checkout@${SHA} # v4.1.0
      - uses: ./.github/actions/local
      - uses: docker://alpine:3.19
      - uses: org/reusable/.github/workflows/x.yml@v1
`;
    const refs = collectAuditRefs(yaml);
    const slugs = refs.map((r) => r.slug);
    expect(slugs).toContain("actions/checkout");
    expect(slugs).toContain("org/reusable");
    expect(slugs).not.toContain("./.github");
    expect(refs.find((r) => r.slug === "actions/checkout")?.comment).toBe("v4.1.0");
  });
});

describe("workflowSupplyChainAudit (#292)", () => {
  test("flags stale pin, impostor, archived, and pin/comment mismatch", async () => {
    const resolver = recordedResolver({
      // SHA no longer on any tag → stale; actual tag differs from comment → mismatch
      [`actions/checkout@${SHA}`]: { exists: true, tags: ["v4.2.0"], archived: false, advisories: [] },
      "evil/typo-action@v1": { exists: false, tags: [], archived: false, advisories: [] },
      "archived/old-action@v2": { exists: true, tags: ["v2"], archived: true, advisories: ["GHSA-xxxx"] },
    });
    const result = await workflowSupplyChainAudit({ yaml: WORKFLOW, resolver, mode: "issue" });
    const kinds = result.findings.map((f) => `${f.slug}:${f.kind}`);

    expect(kinds).toContain("evil/typo-action:impostor");
    expect(kinds).toContain("archived/old-action:archived");
    expect(kinds).toContain("archived/old-action:advisory");
    expect(kinds).toContain("actions/checkout:pin-comment-mismatch");
    expect(result.mode).toBe("issue");
    expect(result.summary).toContain("Workflow supply-chain audit");
  });

  test("flags a stale SHA pin with no upstream tag", async () => {
    const resolver = recordedResolver({
      [`actions/checkout@${SHA}`]: { exists: true, tags: [], archived: false, advisories: [] },
      "evil/typo-action@v1": { exists: true, tags: ["v1"], archived: false, advisories: [] },
      "archived/old-action@v2": { exists: true, tags: ["v2"], archived: false, advisories: [] },
    });
    const result = await workflowSupplyChainAudit({ yaml: WORKFLOW, resolver });
    expect(result.findings.some((f) => f.slug === "actions/checkout" && f.kind === "stale-pin")).toBe(true);
  });

  test("clean workflow yields no findings", async () => {
    const yaml = `jobs:
  build:
    steps:
      - uses: actions/checkout@${SHA}
`;
    const resolver = recordedResolver({
      [`actions/checkout@${SHA}`]: { exists: true, tags: ["v4"], archived: false, advisories: [] },
    });
    const result = await workflowSupplyChainAudit({ yaml, resolver });
    expect(result.findings).toHaveLength(0);
    expect(result.summary).toContain("No live drift");
  });
});
