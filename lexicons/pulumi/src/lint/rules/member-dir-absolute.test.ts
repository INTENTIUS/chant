import { describe, expect, test } from "vitest";
import * as ts from "typescript";
import type { LintContext } from "@intentius/chant/lint/rule";
import { isAbsolutePath, memberDirAbsoluteRule } from "./member-dir-absolute";

function createContext(code: string, fileName = "chant.config.ts"): LintContext {
  const sourceFile = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true);
  return { sourceFile, entities: [], filePath: fileName };
}

describe("PUL101: pulumi.member.dir is absolute", () => {
  test("flags an absolute dir in the config namespace", () => {
    const diags = memberDirAbsoluteRule.check(
      createContext(`export default { lexicons: ["pulumi"], pulumi: { member: { dir: "/home/me/infra", label: "infra" } } };`),
    );
    expect(diags).toHaveLength(1);
    expect(diags[0].ruleId).toBe("PUL101");
    expect(diags[0].severity).toBe("warning");
    expect(diags[0].message).toContain("/home/me/infra");
    expect(diags[0].line).toBe(1);
  });

  test("passes a relative dir", () => {
    expect(memberDirAbsoluteRule.check(createContext(`export default { pulumi: { member: { dir: "./infra" } } };`))).toEqual([]);
    expect(memberDirAbsoluteRule.check(createContext(`export default { pulumi: { member: { dir: "infra" } } };`))).toEqual([]);
  });

  test("stays silent on a computed dir and on a dir outside pulumi.member", () => {
    expect(memberDirAbsoluteRule.check(createContext(`export default { pulumi: { member: { dir: join(root, "infra") } } };`))).toEqual([]);
    expect(memberDirAbsoluteRule.check(createContext(`export default { terraform: { roots: { app: { dir: "/abs" } } } };`))).toEqual([]);
  });

  test("reads POSIX, home-relative and Windows absolute forms", () => {
    for (const p of ["/x", "~/x", "C:\\x", "C:/x", "\\\\server\\share"]) expect(isAbsolutePath(p)).toBe(true);
    for (const p of ["x", "./x", "../x"]) expect(isAbsolutePath(p)).toBe(false);
  });
});
