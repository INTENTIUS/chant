import { describe, expect, it } from "vitest";
import { completions } from "./completions";

const at = (content: string) => {
  const lines = content.split("\n");
  const line = lines.length - 1;
  return { uri: "file:///x.op.ts", content, position: { line, character: lines[line].length }, wordAtCursor: "", linePrefix: lines[line] };
};

describe("systemone completions", () => {
  it("completes the decide step's options", () => {
    expect(completions(at('decide("triage", {')).map((c) => c.label)).toContain("read");
  });

  it("completes the config namespace, a backend and a key", () => {
    expect(completions(at("export default { systemone: {")).map((c) => c.label)).toEqual(["backends"]);
    expect(completions(at("export default { systemone: { backends: { jev: {")).map((c) => c.label)).toEqual(["url", "key", "timeoutMs"]);
    expect(completions(at('export default { systemone: { backends: { jev: { url: "x", key: {')).map((c) => c.label)).toEqual(["env", "capability", "member"]);
  });

  it("offers nothing elsewhere", () => {
    expect(completions(at("const x = {"))).toEqual([]);
  });
});
