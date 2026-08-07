import ts from "typescript";
import type { LintRule, LintDiagnostic, LintContext } from "@intentius/chant/lint/rule";

/**
 * CPL002: prefer a resource reference over a hand-written link.
 *
 * The cpln serializer resolves a declared resource passed where a link is
 * expected into the correct link for its kind — including the GVC qualifier
 * that the identity form needs and that is silently ignored when missing. A
 * hand-spelled `"//gvc/prod/identity/api"` gets none of that: it does not
 * follow a rename, it is not checked against anything at author time, and
 * getting the shape subtly wrong fails at runtime rather than at apply.
 *
 * This is a style rule, not a correctness one — the literal form is valid, and
 * is the only option for a resource this stack does not declare. It fires on
 * the link syntax specifically, so ordinary strings are untouched.
 *
 * Not flagged: `cpln://secret/…` and `cpln://volumeset/…`. Those are runtime
 * *resolution* URIs read by the container, not links between resources, and
 * they have no reference form to prefer.
 */

const CPLN_KINDS = new Set(["Gvc", "Workload", "Identity", "VolumeSet", "Secret", "Policy", "Domain", "IpSet"]);

/** `//gvc/prod/identity/api` or `//secret/db-password`. */
const LINK = /^\/\/(?:gvc\/[^/\s]+\/)?(gvc|workload|identity|volumeset|secret|policy|domain|ipset)\/[^/\s]+$/;

export const preferResourceReferenceRule: LintRule = {
  id: "CPL002",
  severity: "info",
  category: "style",
  description: "Prefer passing a declared resource over a hand-written Control Plane link",

  check(context: LintContext): LintDiagnostic[] {
    const diagnostics: LintDiagnostic[] = [];
    const source = context.sourceFile;

    const visit = (node: ts.Node, insideCplnNew: boolean): void => {
      let inside = insideCplnNew;

      if (ts.isNewExpression(node)) {
        const name = node.expression.getText(source);
        const short = name.split(".").pop() ?? name;
        if (CPLN_KINDS.has(short)) inside = true;
      }

      if (inside && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))) {
        const match = LINK.exec(node.text);
        if (match) {
          const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source));
          diagnostics.push({
            ruleId: "CPL002",
            severity: "info",
            message:
              `Hand-written link "${node.text}". If the ${match[1]} is declared in this stack, pass the ` +
              `resource itself — the serializer emits the correct link, including the GVC qualifier, and ` +
              `the reference follows a rename.`,
            file: context.filePath,
            line: line + 1,
            column: character + 1,
          });
        }
      }

      ts.forEachChild(node, (child) => visit(child, inside));
    };

    visit(source, false);
    return diagnostics;
  },
};
