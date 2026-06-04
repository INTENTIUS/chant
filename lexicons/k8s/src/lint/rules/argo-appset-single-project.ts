import type { LintRule, LintDiagnostic, LintContext } from "@intentius/chant/lint/rule";
import { findResourceLiterals, getNestedObject, getNestedString, lineCol } from "./argo-ast";

/**
 * ARGO004: ApplicationSet template must scope to a single AppProject
 *
 * An `ApplicationSet` generates many Applications from one template. The
 * template's `spec.project` should name a single, static `AppProject` so every
 * generated Application lands in the same security boundary. If `project` is
 * missing, the generated Applications fall back to whatever default and dodge
 * project-level RBAC; if it is templated with a generator placeholder
 * (`{{...}}`) the set sprays Applications across many projects, which defeats
 * the point of an AppProject as a guardrail.
 *
 * Bad:  new ApplicationSet({ spec: { template: { spec: { repoURL: "..." } } } })          // no project
 * Bad:  new ApplicationSet({ spec: { template: { spec: { project: "{{path.basename}}" } } } }) // templated
 * Good: new ApplicationSet({ spec: { template: { spec: { project: "team-a" } } } })
 */

export const argoAppSetSingleProjectRule: LintRule = {
  id: "ARGO004",
  severity: "warning",
  category: "correctness",
  description:
    "ApplicationSet template must scope to a single static AppProject (spec.template.spec.project)",

  check(context: LintContext): LintDiagnostic[] {
    const { sourceFile } = context;
    const diagnostics: LintDiagnostic[] = [];

    for (const { literal } of findResourceLiterals(sourceFile, new Set(["ApplicationSet"]))) {
      const templateSpec = getNestedObject(literal, ["spec", "template", "spec"]);
      // No template/spec to inspect — leave it to other tooling.
      if (!templateSpec) continue;

      const project = getNestedString(literal, ["spec", "template", "spec", "project"]);
      const { line, column } = lineCol(sourceFile, templateSpec);

      if (project === undefined) {
        diagnostics.push({
          file: sourceFile.fileName,
          line,
          column,
          ruleId: "ARGO004",
          severity: "warning",
          message:
            "ApplicationSet template has no spec.project — scope it to a single AppProject so every generated Application inherits the same RBAC boundary.",
        });
        continue;
      }

      if (project.includes("{{")) {
        diagnostics.push({
          file: sourceFile.fileName,
          line,
          column,
          ruleId: "ARGO004",
          severity: "warning",
          message: `ApplicationSet template scopes spec.project to a generator placeholder ("${project}"), spraying Applications across projects. Pin it to a single static AppProject.`,
        });
      }
    }

    return diagnostics;
  },
};
