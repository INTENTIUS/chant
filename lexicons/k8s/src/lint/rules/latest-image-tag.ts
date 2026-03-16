import type { LintRule, LintDiagnostic, LintContext } from "@intentius/chant/lint/rule";
import * as ts from "typescript";

/**
 * WK8002: Latest Image Tag
 *
 * Detects when a K8s workload resource uses the `:latest` image tag or no tag
 * at all in a container image string literal. Untagged or `:latest` images are
 * non-deterministic and can cause unexpected rollouts.
 *
 * Bad:  new Deployment({ spec: { template: { spec: { containers: [{ image: "nginx:latest" }] } } } })
 * Bad:  new Deployment({ spec: { template: { spec: { containers: [{ image: "nginx" }] } } } })
 * Good: new Deployment({ spec: { template: { spec: { containers: [{ image: "nginx:1.25" }] } } } })
 */

const WORKLOAD_KINDS = new Set([
  "Deployment",
  "StatefulSet",
  "DaemonSet",
  "CronJob",
  "Job",
  "ReplicaSet",
  "Pod",
]);

/**
 * Returns true if the string looks like a container image reference that is
 * either untagged or using `:latest`.
 *
 * A string is considered a container image if it:
 * - Contains at least one alphabetic character
 * - Does not contain spaces
 * - Is not a simple keyword like "true", "false", etc.
 */
function isProblematicImage(value: string): boolean {
  if (!value || value.includes(" ") || value.length === 0) return false;

  // Skip values that are clearly not images
  const nonImagePatterns = [
    /^(true|false|null|undefined|yes|no)$/i,
    /^\d+$/, // pure numbers
    /^[.\/]/, // relative/absolute paths without image-like structure
  ];
  for (const pat of nonImagePatterns) {
    if (pat.test(value)) return false;
  }

  // Check for :latest explicitly
  if (value.endsWith(":latest")) return true;

  // Check for untagged image: no colon at all, but looks like an image name
  // Images contain alphanumeric chars and may have / for registry prefix
  // Must have at least one alpha char and match image naming conventions
  if (!value.includes(":") && !value.includes("@") && /^[a-zA-Z0-9._\-\/]+$/.test(value) && /[a-zA-Z]/.test(value)) {
    return true;
  }

  return false;
}

export const latestImageTagRule: LintRule = {
  id: "WK8002",
  severity: "warning",
  category: "security",
  description:
    "Detects :latest or untagged container images — use explicit version tags for reproducibility",

  check(context: LintContext): LintDiagnostic[] {
    const { sourceFile } = context;
    const diagnostics: LintDiagnostic[] = [];

    function isInsideWorkloadConstructor(node: ts.Node): boolean {
      let current: ts.Node | undefined = node.parent;
      while (current) {
        if (
          ts.isNewExpression(current) &&
          ts.isIdentifier(current.expression) &&
          WORKLOAD_KINDS.has(current.expression.text)
        ) {
          return true;
        }
        current = current.parent;
      }
      return false;
    }

    function visit(node: ts.Node): void {
      // Look for property assignments like `image: "nginx:latest"` or `image: "nginx"`
      if (
        ts.isPropertyAssignment(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === "image" &&
        ts.isStringLiteral(node.initializer) &&
        isInsideWorkloadConstructor(node)
      ) {
        const value = node.initializer.text;
        if (isProblematicImage(value)) {
          const { line, character } =
            sourceFile.getLineAndCharacterOfPosition(
              node.initializer.getStart(),
            );
          const isLatest = value.endsWith(":latest");
          diagnostics.push({
            file: sourceFile.fileName,
            line: line + 1,
            column: character + 1,
            ruleId: "WK8002",
            severity: "warning",
            message: isLatest
              ? `Container image "${value}" uses the :latest tag. Pin to a specific version for reproducibility.`
              : `Container image "${value}" has no tag. Pin to a specific version for reproducibility.`,
          });
        }
      }
      ts.forEachChild(node, visit);
    }

    visit(sourceFile);
    return diagnostics;
  },
};
