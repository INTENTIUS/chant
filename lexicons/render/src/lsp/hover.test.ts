import { describe, expect, it } from "vitest";
import { hover } from "./hover";

describe("render LSP hover", () => {
  it("returns undefined for an unknown word", () => {
    expect(
      hover({ uri: "file:///a.ts", content: "const x = 42", position: { line: 0, character: 8 }, word: "x", lineText: "const x = 42" }),
    ).toBeUndefined();
  });

  it("describes a resource with its collection and marker, and a property as nested", () => {
    const web = hover({
      uri: "file:///infra.ts",
      content: "new WebService({})",
      position: { line: 0, character: 6 },
      word: "WebService",
      lineText: "new WebService({})",
    });
    expect(web?.contents).toContain("Render::Services::WebService");
    expect(web?.contents).toContain("POST /services");
    expect(web?.contents).toContain("CHANT_MANAGED_BY");

    const details = hover({
      uri: "file:///infra.ts",
      content: "new WebServiceDetails({})",
      position: { line: 0, character: 6 },
      word: "WebServiceDetails",
      lineText: "new WebServiceDetails({})",
    });
    expect(details?.contents).toContain("Property");
  });
});
