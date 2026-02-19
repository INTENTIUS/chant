import * as ts from "typescript";
import type { LintRule, LintContext, LintDiagnostic, LintFix, Severity, Category } from "./rule";
import { resolveSelector } from "./selectors";
import { getNamedCheck } from "./named-checks";

/**
 * Condition for matching nodes within a selector result.
 */
export interface MatchCondition {
  /** RegExp pattern to match the node's text */
  pattern?: RegExp;
  /** Selector name — only match if node is within a parent matching this selector */
  within?: string;
  /** Require specific child selector(s) to be present */
  require?: string | string[];
  /** Named check to evaluate */
  check?: string;
}

/**
 * Declarative fix description.
 */
export interface DeclarativeFix {
  /** Kind of fix operation */
  kind: "replace" | "insert-before" | "insert-after" | "delete";
  /** Static replacement text */
  text?: string;
  /** Dynamic resolve function for the replacement text */
  resolve?: (node: ts.Node, sf: ts.SourceFile) => string;
}

/**
 * Specification for a declarative lint rule.
 */
export interface RuleSpec {
  /** Unique rule ID */
  id: string;
  /** Severity level */
  severity: Severity;
  /** Category for grouping */
  category: Category;
  /** Selector name (or compound) to find target nodes */
  selector: string;
  /** Optional match condition to further filter nodes */
  match?: MatchCondition;
  /** Message template. `{node}` is replaced with the node's text. */
  message: string;
  /** Optional fix to apply */
  fix?: DeclarativeFix;
  /** Optional custom validation function */
  validate?: (node: ts.Node, context: LintContext) => boolean;
}

/**
 * Build a standard LintRule from a declarative RuleSpec.
 */
export function rule(spec: RuleSpec): LintRule {
  const selectorFn = resolveSelector(spec.selector);

  return {
    id: spec.id,
    severity: spec.severity,
    category: spec.category,
    check(context: LintContext): LintDiagnostic[] {
      const diagnostics: LintDiagnostic[] = [];
      const sf = context.sourceFile;
      let nodes = selectorFn(sf);

      // Apply match conditions
      if (spec.match) {
        nodes = nodes.filter((node) => matchNode(node, spec.match!, sf, context));
      }

      // Apply custom validation
      if (spec.validate) {
        nodes = nodes.filter((node) => spec.validate!(node, context));
      }

      for (const node of nodes) {
        const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        const nodeText = node.getText(sf);
        const message = spec.message.replace(/\{node\}/g, nodeText);

        const diagnostic: LintDiagnostic = {
          file: context.filePath,
          line: line + 1,
          column: character + 1,
          ruleId: spec.id,
          severity: spec.severity,
          message,
        };

        if (spec.fix) {
          diagnostic.fix = buildFix(node, spec.fix, sf);
        }

        diagnostics.push(diagnostic);
      }

      return diagnostics;
    },
  };
}

/**
 * Check if a node matches the given condition.
 */
function matchNode(
  node: ts.Node,
  condition: MatchCondition,
  sf: ts.SourceFile,
  context: LintContext,
): boolean {
  // Pattern match
  if (condition.pattern) {
    const text = node.getText(sf);
    if (!condition.pattern.test(text)) return false;
  }

  // Within match — node must be inside a parent matching the selector
  if (condition.within) {
    const parentSelector = resolveSelector(condition.within);
    const parents = parentSelector(sf);
    const isWithin = parents.some((parent) => isAncestorOf(parent, node));
    if (!isWithin) return false;
  }

  // Require match — node must contain children matching the selector(s)
  if (condition.require) {
    const reqs = Array.isArray(condition.require) ? condition.require : [condition.require];
    for (const req of reqs) {
      const childSelector = resolveSelector(req);
      const children = childSelector(sf);
      const hasChild = children.some((child) => isAncestorOf(node, child));
      if (!hasChild) return false;
    }
  }

  // Named check
  if (condition.check) {
    const checkFn = getNamedCheck(condition.check);
    if (!checkFn) {
      throw new Error(`Unknown named check: "${condition.check}"`);
    }
    if (!checkFn(node, context)) return false;
  }

  return true;
}

/**
 * Check if `ancestor` is an ancestor of `node`.
 */
function isAncestorOf(ancestor: ts.Node, node: ts.Node): boolean {
  let current = node.parent;
  while (current) {
    if (current === ancestor) return true;
    current = current.parent;
  }
  return false;
}

/**
 * Build a LintFix from a declarative fix spec.
 */
function buildFix(node: ts.Node, fix: DeclarativeFix, sf: ts.SourceFile): LintFix {
  const start = node.getStart(sf);
  const end = node.getEnd();

  switch (fix.kind) {
    case "replace": {
      const text = fix.resolve ? fix.resolve(node, sf) : (fix.text ?? "");
      return { range: [start, end], replacement: text, kind: "replace" };
    }
    case "insert-before": {
      const text = fix.resolve ? fix.resolve(node, sf) : (fix.text ?? "");
      return { range: [start, start], replacement: text, kind: "insert-before" };
    }
    case "insert-after": {
      const text = fix.resolve ? fix.resolve(node, sf) : (fix.text ?? "");
      return { range: [end, end], replacement: text, kind: "insert-after" };
    }
    case "delete": {
      return { range: [start, end], replacement: "", kind: "delete" };
    }
  }
}
