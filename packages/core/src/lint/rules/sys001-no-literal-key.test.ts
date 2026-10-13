import { describe, expect, it } from "vitest";
import ts from "typescript";
import { noLiteralKeyRule } from "./sys001-no-literal-key";
import { loadCoreRules } from "./index";

const run = (code: string) =>
  noLiteralKeyRule.check({ sourceFile: ts.createSourceFile("x.ts", code, ts.ScriptTarget.Latest, true), filePath: "x.ts", entities: [] } as never);

describe("SYS001", () => {
  it("is one of core's rules", () => {
    expect(loadCoreRules().map((r) => r.id)).toContain("SYS001");
  });

  it("fires on a literal key in the config's decide block", () => {
    const d = run(`export default { decide: { backends: { s: { url: "https://x", key: "sk-abc" } } } };`);
    expect(d.map((x) => x.ruleId)).toEqual(["SYS001"]);
  });

  it("fires on a literal key in a decide step's backends", () => {
    expect(run('decide("p", { backends: { s: { url: "https://x", key: `k` } } });')).toHaveLength(1);
  });

  it("is quiet for { env } and a brokered capability", () => {
    expect(run(`export default { decide: { backends: { s: { url: "https://x", key: { env: "K" } }, b: { url: "http://127.0.0.1", key: { capability: "inference" } } } } };`)).toEqual([]);
  });

  it("is quiet for a key property outside decide, and for another tool's backends", () => {
    expect(run(`const x = { key: "not a backend" };`)).toEqual([]);
    expect(run(`const tf = { backends: { s3: { bucket: "b", key: "state/terraform.tfstate" } } };`)).toEqual([]);
  });
});
