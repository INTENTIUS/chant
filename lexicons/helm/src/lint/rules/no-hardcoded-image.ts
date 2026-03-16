/**
 * WHM003: Container Images Should Use Values References
 *
 * Detects container image strings that are hardcoded in K8s resource
 * constructors instead of using values references. In Helm charts, images
 * should be parameterized via values.yaml so they can be overridden at
 * install time.
 *
 * Bad:  image: "nginx:1.19"
 * Good: image: printf("%s:%s", values.image.repository, values.image.tag)
 */

import type { LintRule, LintDiagnostic, LintContext } from "@intentius/chant/lint/rule";
import * as ts from "typescript";

/**
 * Pattern matching common container image references.
 * Matches strings like "nginx:1.19", "registry.io/app:latest", etc.
 */
const IMAGE_PATTERN = /^[a-z0-9][a-z0-9._/-]*:[a-z0-9][a-z0-9._-]*$/i;

export const noHardcodedImageRule: LintRule = {
  id: "WHM003",
  severity: "warning",
  category: "correctness",
  description:
    "Container images should use values references, not hardcoded tags",

  check(context: LintContext): LintDiagnostic[] {
    const { sourceFile } = context;
    const diagnostics: LintDiagnostic[] = [];

    function visit(node: ts.Node): void {
      // Look for property assignments: `image: "nginx:1.19"`
      if (
        ts.isPropertyAssignment(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === "image" &&
        ts.isStringLiteral(node.initializer)
      ) {
        const value = node.initializer.text;
        if (IMAGE_PATTERN.test(value)) {
          const { line, character } = sourceFile.getLineAndCharacterOfPosition(
            node.initializer.getStart(),
          );
          diagnostics.push({
            file: sourceFile.fileName,
            line: line + 1,
            column: character + 1,
            ruleId: "WHM003",
            severity: "warning",
            message: `Hardcoded image "${value}" — use values references (e.g. printf("%s:%s", values.image.repository, values.image.tag)) for Helm chart parameterization`,
          });
        }
      }
      ts.forEachChild(node, visit);
    }

    visit(sourceFile);
    return diagnostics;
  },
};
