import type { LintRule, LintDiagnostic, LintContext } from "@intentius/chant/lint/rule";
import * as ts from "typescript";

/**
 * WAW006: S3 Bucket Encryption
 *
 * Detects S3 Bucket creation without encryption configuration.
 * All S3 buckets should have server-side encryption enabled.
 */
export const s3EncryptionRule: LintRule = {
  id: "WAW006",
  severity: "warning",
  category: "security",

  check(context: LintContext): LintDiagnostic[] {
    const { sourceFile } = context;
    const diagnostics: LintDiagnostic[] = [];

    function visit(node: ts.Node): void {
      // Look for `new Bucket(...)` or `new aws.s3.Bucket(...)`
      if (ts.isNewExpression(node)) {
        const expression = node.expression;
        let isBucket = false;

        // Check for `new Bucket(...)`
        if (ts.isIdentifier(expression) && expression.text === "Bucket") {
          isBucket = true;
        }
        // Check for `new s3.Bucket(...)` or `new aws.s3.Bucket(...)`
        else if (ts.isPropertyAccessExpression(expression)) {
          if (expression.name.text === "Bucket") {
            isBucket = true;
          }
        }

        if (isBucket && node.arguments && node.arguments.length > 0) {
          const props = node.arguments[0];
          if (ts.isObjectLiteralExpression(props)) {
            const hasEncryption = props.properties.some((prop) => {
              if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name)) {
                return prop.name.text === "BucketEncryption" ||
                       prop.name.text === "ServerSideEncryptionConfiguration";
              }
              return false;
            });

            if (!hasEncryption) {
              const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
              diagnostics.push({
                file: sourceFile.fileName,
                line: line + 1,
                column: character + 1,
                ruleId: "WAW006",
                severity: "warning",
                message: "S3 Bucket created without encryption configuration. Enable server-side encryption.",
              });
            }
          }
        }
      }

      ts.forEachChild(node, visit);
    }

    visit(sourceFile);
    return diagnostics;
  },
};
