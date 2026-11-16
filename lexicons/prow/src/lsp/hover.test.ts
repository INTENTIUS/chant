import { describe, expect, it } from "vitest";
import { hover } from "./hover";

const at = (word: string) => ({ uri: "file:///jobs.ts", content: `new ${word}({})`, position: { line: 0, character: 6 }, word, lineText: `new ${word}({})` });

describe("prow LSP hover", () => {
  it("returns undefined for an unknown word", () => {
    expect(hover(at("x"))).toBeUndefined();
  });

  it("describes a job kind as a job, and a pod spec type as a nested value", () => {
    expect(hover(at("Presubmit"))?.contents).toContain("Prow::Presubmit");
    expect(hover(at("Presubmit"))?.contents).toContain("job config");
    expect(hover(at("Container"))?.contents).toContain("nested in a job");
  });
});
