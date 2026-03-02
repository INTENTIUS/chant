import type { LintRule, LintDiagnostic, LintContext } from "@intentius/chant/lint/rule";
import * as ts from "typescript";

/**
 * WK8003: Missing Resource Limits
 *
 * Detects when a container in a Deployment/StatefulSet spec doesn't have
 * resource limits or requests. Without resource limits, a container can
 * consume unbounded cluster resources and cause noisy-neighbour issues.
 *
 * Bad:  new Deployment({ spec: { template: { spec: { containers: [{ name: "app", image: "app:1.0" }] } } } })
 * Good: new Deployment({ spec: { template: { spec: { containers: [{ name: "app", image: "app:1.0", resources: { limits: { cpu: "500m", memory: "256Mi" } } }] } } } })
 */

const WORKLOAD_KINDS = new Set([
  "Deployment",
  "StatefulSet",
  "DaemonSet",
  "CronJob",
  "Job",
  "ReplicaSet",
]);

export const missingResourceLimitsRule: LintRule = {
  id: "WK8003",
  severity: "warning",
  category: "correctness",
  description:
    "Detects containers without resource limits/requests — always set resource constraints",

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

    function objectLiteralHasProperty(
      obj: ts.ObjectLiteralExpression,
      name: string,
    ): boolean {
      return obj.properties.some(
        (p) =>
          ts.isPropertyAssignment(p) &&
          ts.isIdentifier(p.name) &&
          p.name.text === name,
      );
    }

    function visit(node: ts.Node): void {
      // Look for object literals inside arrays that represent container specs.
      // A container object literal typically has "name" and "image" properties.
      // We flag it if it lacks a "resources" property.
      if (
        ts.isObjectLiteralExpression(node) &&
        isInsideWorkloadConstructor(node)
      ) {
        const hasName = objectLiteralHasProperty(node, "name");
        const hasImage = objectLiteralHasProperty(node, "image");
        const hasResources = objectLiteralHasProperty(node, "resources");

        if (hasName && hasImage && !hasResources) {
          // Confirm we're inside an array literal (containers array)
          if (node.parent && ts.isArrayLiteralExpression(node.parent)) {
            const { line, character } =
              sourceFile.getLineAndCharacterOfPosition(node.getStart());

            // Try to extract the container name for a better message
            let containerName = "unknown";
            for (const prop of node.properties) {
              if (
                ts.isPropertyAssignment(prop) &&
                ts.isIdentifier(prop.name) &&
                prop.name.text === "name" &&
                ts.isStringLiteral(prop.initializer)
              ) {
                containerName = prop.initializer.text;
                break;
              }
            }

            diagnostics.push({
              file: sourceFile.fileName,
              line: line + 1,
              column: character + 1,
              ruleId: "WK8003",
              severity: "warning",
              message: `Container "${containerName}" is missing resource limits/requests. Set resources.limits and resources.requests to prevent unbounded resource consumption.`,
            });
          }
        }
      }
      ts.forEachChild(node, visit);
    }

    visit(sourceFile);
    return diagnostics;
  },
};
