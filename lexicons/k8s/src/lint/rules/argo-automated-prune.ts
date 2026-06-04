import type { LintRule, LintDiagnostic, LintContext } from "@intentius/chant/lint/rule";
import {
  findResourceLiterals,
  getNestedBoolean,
  getNestedString,
  getProp,
  hasAnnotation,
  lineCol,
} from "./argo-ast";
import * as ts from "typescript";

/**
 * ARGO001: Production Application must not enable automated prune
 *
 * An Argo CD `Application` whose `syncPolicy.automated.prune` is `true` lets the
 * controller delete live resources that disappear from git. On a production
 * Application that is a foot-gun — a bad merge can sweep away running
 * infrastructure. Require `prune: false` for prod Applications unless the author
 * opts in explicitly with the `argocd.chant.dev/allow-prune` annotation.
 *
 * "Production" is inferred from the Application name, its `metadata.namespace`,
 * or its `spec.destination.namespace` containing `prod`.
 *
 * Bad:  new Application({ metadata: { name: "api-prod" }, spec: { syncPolicy: { automated: { prune: true } } } })
 * Good: new Application({ metadata: { name: "api-prod" }, spec: { syncPolicy: { automated: { prune: false } } } })
 * Good: new Application({ metadata: { name: "api-prod", annotations: { "argocd.chant.dev/allow-prune": "true" } }, spec: { syncPolicy: { automated: { prune: true } } } })
 */

export const ALLOW_PRUNE_ANNOTATION = "argocd.chant.dev/allow-prune";

function looksProd(obj: ts.ObjectLiteralExpression): boolean {
  const candidates = [
    getNestedString(obj, ["metadata", "name"]),
    getNestedString(obj, ["metadata", "namespace"]),
    getNestedString(obj, ["spec", "destination", "namespace"]),
  ];
  return candidates.some((v) => v !== undefined && /prod/i.test(v));
}

export const argoAutomatedPruneRule: LintRule = {
  id: "ARGO001",
  severity: "warning",
  category: "correctness",
  description:
    "Production Argo Application must not enable syncPolicy.automated.prune without the allow-prune override annotation",

  check(context: LintContext): LintDiagnostic[] {
    const { sourceFile } = context;
    const diagnostics: LintDiagnostic[] = [];

    for (const { literal } of findResourceLiterals(sourceFile, new Set(["Application"]))) {
      const prune = getNestedBoolean(literal, ["spec", "syncPolicy", "automated", "prune"]);
      if (prune !== true) continue;
      if (!looksProd(literal)) continue;
      if (hasAnnotation(literal, ALLOW_PRUNE_ANNOTATION)) continue;

      // Anchor the diagnostic at the `prune` assignment when we can find it.
      const automated = getProp(literal, "spec");
      const anchor: ts.Node = automated ?? literal;
      const { line, column } = lineCol(sourceFile, anchor);

      const name = getNestedString(literal, ["metadata", "name"]) ?? "(unnamed)";
      diagnostics.push({
        file: sourceFile.fileName,
        line,
        column,
        ruleId: "ARGO001",
        severity: "warning",
        message: `Production Application "${name}" enables automated prune. Set syncPolicy.automated.prune=false, or opt in explicitly with the "${ALLOW_PRUNE_ANNOTATION}" annotation.`,
      });
    }

    return diagnostics;
  },
};
