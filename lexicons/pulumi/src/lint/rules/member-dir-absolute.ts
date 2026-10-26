import { ts } from "@intentius/chant/lint/typescript";
import type { LintContext, LintDiagnostic, LintRule } from "@intentius/chant/lint/rule";

/**
 * PUL101: `pulumi.member.dir` is an absolute path written in source.
 *
 * `chant workspace graph` writes `pulumi.member` into the reader project it
 * makes for a member of kind `pulumi`, with `dir` absolute, because that
 * project lives in a scratch directory and is thrown away. A project that
 * writes the namespace itself (to read a member's graph into its own build,
 * as `examples/workspace-member` does) commits the path, and an absolute one
 * names a directory on the author's machine: on a CI runner or a second
 * checkout the member is not found, and the build reads no graph (PUL001).
 * A relative `dir` resolves against the project root, the directory that
 * holds `chant.config.ts`, so it travels with the repository.
 *
 * Matches the literal shape only: a `pulumi: { member: { dir: "<literal>" } }`
 * object, at any depth. A computed `dir` (`join(...)`, a template with
 * substitutions, an identifier) is out of reach and stays silent.
 */
export const memberDirAbsoluteRule: LintRule = {
  id: "PUL101",
  severity: "warning",
  category: "correctness",
  description: "pulumi.member.dir is an absolute path; a relative dir resolves against the project root and travels with the repository",

  check(context: LintContext): LintDiagnostic[] {
    const diagnostics: LintDiagnostic[] = [];
    const source = context.sourceFile;

    const propName = (prop: ts.ObjectLiteralElementLike): string | undefined => {
      if (!ts.isPropertyAssignment(prop)) return undefined;
      if (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name)) return prop.name.text;
      return undefined;
    };

    const objectProp = (obj: ts.ObjectLiteralExpression, name: string): ts.ObjectLiteralExpression | undefined => {
      for (const prop of obj.properties) {
        if (propName(prop) !== name) continue;
        const value = (prop as ts.PropertyAssignment).initializer;
        if (ts.isObjectLiteralExpression(value)) return value;
      }
      return undefined;
    };

    const checkMember = (member: ts.ObjectLiteralExpression) => {
      for (const prop of member.properties) {
        if (propName(prop) !== "dir") continue;
        const value = (prop as ts.PropertyAssignment).initializer;
        if (!ts.isStringLiteral(value) && !ts.isNoSubstitutionTemplateLiteral(value)) continue;
        if (!isAbsolutePath(value.text)) continue;
        const { line, character } = source.getLineAndCharacterOfPosition(value.getStart(source));
        diagnostics.push({
          ruleId: "PUL101",
          severity: "warning",
          message:
            `pulumi.member.dir "${value.text}" is an absolute path, which names a directory on this machine only. ` +
            "Write it relative to the project root (the directory holding chant.config.ts), such as \"./infra\".",
          file: context.filePath,
          line: line + 1,
          column: character + 1,
        });
      }
    };

    const visit = (node: ts.Node) => {
      if (ts.isObjectLiteralExpression(node)) {
        const pulumi = objectProp(node, "pulumi");
        const member = pulumi ? objectProp(pulumi, "member") : undefined;
        if (member) checkMember(member);
      }
      ts.forEachChild(node, visit);
    };

    visit(source);
    return diagnostics;
  },
};

/** POSIX `/x`, `~/x`, and Windows `C:\x` / `C:/x` or `\\server\share`. */
export function isAbsolutePath(p: string): boolean {
  return p.startsWith("/") || p.startsWith("~/") || /^[A-Za-z]:[\\/]/.test(p) || p.startsWith("\\\\");
}
