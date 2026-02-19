import { describe, test, expect } from "bun:test";
import { awsHover } from "./hover";
import type { HoverContext } from "@intentius/chant/lsp/types";

function makeCtx(overrides: Partial<HoverContext>): HoverContext {
  return {
    uri: "file:///test.ts",
    content: "",
    position: { line: 0, character: 0 },
    word: "",
    lineText: "",
    ...overrides,
  };
}

describe("awsHover", () => {
  test("returns hover info for Bucket", () => {
    const ctx = makeCtx({ word: "Bucket" });
    const info = awsHover(ctx);

    expect(info).toBeDefined();
    expect(info!.contents).toContain("Bucket");
    expect(info!.contents).toContain("AWS::S3::Bucket");
  });

  test("shows attributes for resource types", () => {
    const ctx = makeCtx({ word: "Bucket" });
    const info = awsHover(ctx);

    expect(info).toBeDefined();
    expect(info!.contents).toContain("Attributes");
  });

  test("returns undefined for unknown word", () => {
    const ctx = makeCtx({ word: "NotARealResource12345" });
    const info = awsHover(ctx);
    expect(info).toBeUndefined();
  });

  test("returns undefined for empty word", () => {
    const ctx = makeCtx({ word: "" });
    const info = awsHover(ctx);
    expect(info).toBeUndefined();
  });

  test("returns info for Table resource", () => {
    const ctx = makeCtx({ word: "Table" });
    const info = awsHover(ctx);

    expect(info).toBeDefined();
    expect(info!.contents).toContain("AWS::DynamoDB::Table");
  });
});
