import { describe, expect, it } from "vitest";
import type { CompletionContext } from "@intentius/chant/lsp/types";
import { completions } from "./completions";

const complete = (linePrefix: string, wordAtCursor = "") =>
  completions({ uri: "file:///infra.ts", content: "", position: { line: 0, character: 0 }, wordAtCursor, linePrefix } as CompletionContext);

describe("augur completions", () => {
  it("offers the Profile keys inside a Profile construction", () => {
    const items = complete("export const p = new Profile({ ");
    expect(items.map((i) => i.label).sort()).toEqual(["description", "traffic"]);
    expect(items.find((i) => i.label === "traffic")?.documentation).toContain("AUG001");
  });

  it("narrows the keys to what has been typed", () => {
    expect(complete("export const p = new Profile({ tra", "tra").map((i) => i.label)).toEqual(["traffic"]);
  });

  it("offers nothing outside a Profile", () => {
    expect(complete("export const b = new Bucket({ ")).toEqual([]);
  });

  it("offers mapped entity types inside a string", () => {
    const items = complete('const t = "RDS');
    expect(items.map((i) => i.label)).toContain("AWS::RDS::DBInstance");
    expect(items.find((i) => i.label === "AWS::RDS::DBInstance")?.detail).toBe("database (aws)");
  });

  it("offers declared-unmapped types too, marked", () => {
    // Offering only the priced kinds would let an author conclude from an
    // absent completion that a type is unknown, when the table has looked at it
    // and decided. That is the same absent-versus-unread distinction the report
    // is built on, and it does not stop at the editor.
    const items = complete('const t = "IAM');
    const role = items.find((i) => i.label === "AWS::IAM::Role");
    expect(role?.detail).toBe("declared unmapped");
    expect(role?.documentation).toContain("never as zero");
  });

  it("does not dump the whole table on an empty string", () => {
    expect(complete('const t = "')).toEqual([]);
    expect(complete('const t = "A')).toEqual([]);
  });
});
