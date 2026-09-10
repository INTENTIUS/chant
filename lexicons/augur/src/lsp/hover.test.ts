import { describe, expect, it } from "vitest";
import type { HoverContext } from "@intentius/chant/lsp/types";
import { hover } from "./hover";

const hoverAt = (word: string, lineText: string) =>
  hover({ uri: "file:///infra.ts", content: "", position: { line: 0, character: 0 }, word, lineText } as HoverContext);

describe("augur hover", () => {
  it("says what a mapped type becomes on the wire", () => {
    const info = hoverAt("Instance", 'const t = "AWS::EC2::Instance";');
    expect(info?.contents).toContain("**compute**");
    expect(info?.contents).toContain("InstanceType");
  });

  it("says why a declared-unmapped type is withheld", () => {
    const info = hoverAt("LogGroup", 'const t = "AWS::Logs::LogGroup";');
    expect(info?.contents).toContain("Declared unmapped");
    expect(info?.contents).toContain("volume ingested into it");
    expect(info?.contents).toContain("never as a zero");
  });

  it("says nothing about a type the table has never seen", () => {
    expect(hoverAt("Thing", 'const t = "Acme::Widget::Thing";')).toBeUndefined();
  });

  it("does not mistake an unquoted identifier for an entity type", () => {
    expect(hoverAt("Instance", "const Instance = 1;")).toBeUndefined();
  });

  it("documents a Profile key", () => {
    expect(hoverAt("traffic", "  traffic: ")?.contents).toContain("verbatim");
  });

  it("says nothing about a word it has no opinion on", () => {
    expect(hoverAt("bucket", "const bucket = 1;")).toBeUndefined();
    expect(hoverAt("", "")).toBeUndefined();
  });
});
