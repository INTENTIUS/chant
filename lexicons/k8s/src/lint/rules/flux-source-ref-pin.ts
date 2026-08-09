import type { LintRule, LintDiagnostic, LintContext } from "@intentius/chant/lint/rule";
import { findResourceLiterals, getNestedObject, getNestedString, getProp, lineCol } from "./argo-ast";
import * as ts from "typescript";

/**
 * FLUX001: GitRepository must pin spec.ref
 *
 * A Flux `GitRepository` with no `spec.ref` falls back to the `master` branch,
 * which on most repos no longer exists — the source stalls with a checkout
 * error, and every Kustomization downstream of it stalls too. Real estates pin
 * a branch (or tag) on every source; `FluxGitSource` always emits one. Flag
 * hand-written `GitRepository` literals whose spec carries a `url` but no
 * `ref`.
 *
 * Bad:  new GitRepository({ spec: { url: "https://github.com/acme/infra" } })
 * Good: new GitRepository({ spec: { url: "https://github.com/acme/infra", ref: { branch: "main" } } })
 */

export const fluxSourceRefPinRule: LintRule = {
  id: "FLUX001",
  severity: "warning",
  category: "correctness",
  description:
    "Flux GitRepository must pin spec.ref (branch, tag, semver, or commit) — the unset default is the master branch",

  check(context: LintContext): LintDiagnostic[] {
    const { sourceFile } = context;
    const diagnostics: LintDiagnostic[] = [];

    for (const { literal } of findResourceLiterals(sourceFile, new Set(["GitRepository"]))) {
      const spec = getNestedObject(literal, ["spec"]);
      // No spec object literal to inspect — leave it to other tooling.
      if (!spec) continue;
      if (getProp(spec, "ref") !== undefined) continue;

      const anchor: ts.Node = spec;
      const { line, column } = lineCol(sourceFile, anchor);
      const name = getNestedString(literal, ["metadata", "name"]) ?? "(unnamed)";

      diagnostics.push({
        file: sourceFile.fileName,
        line,
        column,
        ruleId: "FLUX001",
        severity: "warning",
        message: `GitRepository "${name}" has no spec.ref — Flux falls back to the master branch. Pin a branch, tag, semver range, or commit.`,
      });
    }

    return diagnostics;
  },
};
