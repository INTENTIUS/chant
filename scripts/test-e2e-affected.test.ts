import { describe, expect, it } from "vitest";
import { EXAMPLE_GATES, selectE2eFiles, touchesExamples } from "./test-e2e-affected";

const e2eFiles = [
  ...EXAMPLE_GATES,
  "examples/examples.e2e.test.ts",
  "packages/core/src/lifecycle/release.e2e.test.ts",
  "packages/core/src/lifecycle/release-cut-at.e2e.test.ts",
  "lexicons/gcp/src/op/activities/gcp-apply.e2e.test.ts",
];

describe("selectE2eFiles (#4217)", () => {
  it("runs a changed e2e file and the e2e files beside a changed source file", () => {
    const sel = selectE2eFiles({ changed: ["packages/core/src/lifecycle/release-cut.ts"], e2eFiles });
    expect(sel.files).toEqual(["packages/core/src/lifecycle/release-cut-at.e2e.test.ts", "packages/core/src/lifecycle/release.e2e.test.ts"]);
    expect(selectE2eFiles({ changed: ["lexicons/gcp/src/op/activities/gcp-apply.e2e.test.ts"], e2eFiles }).reasons).toEqual({
      "lexicons/gcp/src/op/activities/gcp-apply.e2e.test.ts": "changed",
    });
  });

  it("adds the three example gates for an example, a serializer or a docs change", () => {
    for (const changed of ["examples/trunk-curated-floci/src/main.ts", "lexicons/gcp/examples/cloud-run/chant.config.ts", "lexicons/gcp/src/serializer.ts", "docs/src/content/docs/contributing/examples.mdx"]) {
      const sel = selectE2eFiles({ changed: [changed], e2eFiles });
      for (const gate of EXAMPLE_GATES) expect(sel.files).toContain(gate);
    }
  });

  it("adds no gate for a core change outside them, and keeps import-graph files", () => {
    const sel = selectE2eFiles({
      changed: ["packages/core/src/graph-ir.ts"],
      e2eFiles,
      related: ["examples/examples.e2e.test.ts", "not/an/e2e/file.ts"],
    });
    expect(sel.files).toEqual(["examples/examples.e2e.test.ts"]);
    expect(sel.reasons["examples/examples.e2e.test.ts"]).toBe("imports a change");
  });

  it("selects nothing for a change no e2e file reaches", () => {
    expect(selectE2eFiles({ changed: ["README.md"], e2eFiles }).files).toEqual([]);
  });
});

describe("touchesExamples", () => {
  it("matches serializer files only under a lexicon's src", () => {
    expect(touchesExamples("lexicons/azure/src/serializer.test.ts")).toBe(true);
    expect(touchesExamples("lexicons/azure/src/codegen/serializer.ts")).toBe(false);
    expect(touchesExamples("packages/core/src/serializer.ts")).toBe(false);
  });
});
