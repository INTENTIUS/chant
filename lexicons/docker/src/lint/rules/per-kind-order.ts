/**
 * DKRS002: Per-kind Dockerfile fields written in a different order
 *
 * A Dockerfile stage without `steps` writes its per-kind fields (`run`,
 * `copy`, `user`, ...) in a fixed order: ARG, ENV, WORKDIR, USER, RUN, COPY,
 * ADD, EXPOSE, VOLUME, LABEL, ENTRYPOINT, CMD, HEALTHCHECK. When the fields
 * are declared in another order (`copy` before `run`, `run` before `user`)
 * the generated Dockerfile does not run them in the order they read in.
 *
 * The fix rewrites the fields as `steps` in the fixed order, so the
 * generated Dockerfile stays the same, with a comment to reorder them.
 */

import type { LintRule, LintDiagnostic, LintContext, LintFix } from "@intentius/chant/lint/rule";
import { ts } from "@intentius/chant/lint/typescript";
import { PER_KIND_ORDER, type PerKindField } from "../../dockerfile-order";

const PER_KIND = new Set<string>(PER_KIND_ORDER);
/** Per-kind fields that take one string; the rest take a list. */
const SINGLE = new Set<string>(["workdir", "user", "entrypoint", "cmd", "healthcheck"]);

const FIX_NOTE = "// Written by the DKRS002 fix in the fixed order the per-kind fields used, so the output is unchanged. Reorder the steps as the build needs.";

function propName(p: ts.ObjectLiteralElementLike): string | undefined {
  if (!(ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p))) return undefined;
  const n = p.name;
  if (ts.isIdentifier(n) || ts.isStringLiteral(n)) return n.text;
  return undefined;
}

function isDockerfileNew(node: ts.Node): node is ts.NewExpression {
  if (!ts.isNewExpression(node)) return false;
  const e = node.expression;
  return (ts.isIdentifier(e) && e.text === "Dockerfile") || (ts.isPropertyAccessExpression(e) && e.name.text === "Dockerfile");
}

/** The stage-shaped object literals of one `new Dockerfile({...})`. */
function stageLiterals(arg: ts.ObjectLiteralExpression): ts.ObjectLiteralExpression[] {
  const stagesProp = arg.properties.find((p) => propName(p) === "stages");
  if (!stagesProp) return [arg];
  // With stages, the top-level per-kind fields are not written at all.
  if (!ts.isPropertyAssignment(stagesProp) || !ts.isArrayLiteralExpression(stagesProp.initializer)) return [];
  return stagesProp.initializer.elements.filter(ts.isObjectLiteralExpression);
}

/** The `{ key: value }` step texts for one per-kind field, or undefined when its value can't be split. */
function stepTexts(sf: ts.SourceFile, key: string, p: ts.ObjectLiteralElementLike): string[] | undefined {
  if (!ts.isPropertyAssignment(p)) return undefined;
  const init = p.initializer;
  if (SINGLE.has(key)) return [`{ ${key}: ${init.getText(sf)} }`];
  if (!ts.isArrayLiteralExpression(init)) return undefined;
  const out: string[] = [];
  for (const el of init.elements) {
    if (ts.isSpreadElement(el) || ts.isOmittedExpression(el)) return undefined;
    out.push(`{ ${key}: ${el.getText(sf)} }`);
  }
  return out;
}

function buildFix(sf: ts.SourceFile, obj: ts.ObjectLiteralExpression, perKind: ts.ObjectLiteralElementLike[]): LintFix | undefined {
  const byKey = new Map<string, ts.ObjectLiteralElementLike>();
  for (const p of perKind) byKey.set(propName(p)!, p);
  const steps: string[] = [];
  for (const key of PER_KIND_ORDER) {
    const p = byKey.get(key);
    if (!p) continue;
    const texts = stepTexts(sf, key, p);
    if (!texts) return undefined;
    steps.push(...texts);
  }

  const first = perKind[0]!;
  const last = perKind[perKind.length - 1]!;
  const start = first.getStart(sf);
  const end = last.getEnd();
  const lineStart = sf.text.lastIndexOf("\n", start - 1) + 1;
  const indent = /^[ \t]*/.exec(sf.text.slice(lineStart, start))![0];
  // Other props between the first and last per-kind field (rare) are kept, ahead of steps.
  const kept = obj.properties.filter((p) => p.getStart(sf) > start && p.getEnd() < end && !perKind.includes(p)).map((p) => p.getText(sf));
  const stepsText = `${FIX_NOTE}\n${indent}steps: [\n${steps.map((s) => `${indent}  ${s},`).join("\n")}\n${indent}]`;
  return { range: [start, end], replacement: [...kept, stepsText].join(`,\n${indent}`), kind: "replace" };
}

function check(context: LintContext): LintDiagnostic[] {
  const { sourceFile: sf } = context;
  const diagnostics: LintDiagnostic[] = [];

  const visit = (node: ts.Node): void => {
    if (isDockerfileNew(node)) {
      const arg = node.arguments?.[0];
      if (arg && ts.isObjectLiteralExpression(arg)) {
        for (const obj of stageLiterals(arg)) {
          if (obj.properties.some((p) => propName(p) === "steps")) continue;
          const perKind = obj.properties.filter((p) => PER_KIND.has(propName(p) ?? ""));
          const declared = perKind.map((p) => propName(p)!);
          const fixed = [...declared].sort((a, b) => PER_KIND_ORDER.indexOf(a as PerKindField) - PER_KIND_ORDER.indexOf(b as PerKindField));
          if (declared.join() === fixed.join()) continue;
          const { line, character } = sf.getLineAndCharacterOfPosition(perKind[0]!.getStart(sf));
          const fix = buildFix(sf, obj, perKind);
          diagnostics.push({
            file: sf.fileName,
            line: line + 1,
            column: character + 1,
            ruleId: "DKRS002",
            severity: "warning",
            message:
              `Dockerfile fields declared as ${declared.join(", ")} are written in the fixed order ${fixed.join(", ")}. ` +
              `Use steps to write the instructions in the order the build needs${fix ? " (chant lint --fix rewrites them as steps)" : ""}.`,
            ...(fix ? { fix } : {}),
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sf);
  return diagnostics;
}

export const perKindOrderRule: LintRule = {
  id: "DKRS002",
  severity: "warning",
  category: "correctness",
  description: "Dockerfile per-kind fields are written in a fixed order that differs from the declared order — use steps",
  check,
  fix(context: LintContext): LintFix[] {
    return check(context).flatMap((d) => (d.fix ? [d.fix] : []));
  },
};
