import * as ts from "typescript";
import type { IntrinsicDef } from "../lexicon";
import {
  SUPPORTED_BINARY_OPERATORS,
  SUPPORTED_UNARY_OPERATORS,
  UNSUPPORTED_OBJECT_MEMBER_MESSAGE,
  UNSUPPORTED_UNARY_MESSAGE,
  callExpressionMessage,
  computedPropertyNameMessage,
  dynamicElementAccessMessage,
  isLiteralElementKey,
  isLiteralPropertyName,
  resourceCtorArgMessage,
  unsupportedBinaryMessage,
  unsupportedExpressionMessage,
  type SubsetRuleId,
} from "./subset";

/**
 * fold — static AST value reducer (chant #1026/#1021/#1024, part of epic #1019)
 *
 * Reduces a single-file TypeScript expression AST to a value with NO
 * module execution. The node-kind/operator/key subset it covers — literals,
 * template interpolation, object/array literals (incl. spread), `const`
 * identifier resolution, property and element access (incl. the
 * cross-resource `{ __attrRef }` case, literal-key-only), unary `!`/`-`,
 * the binary operators `+ - * / === !== > < >= <=`, short-circuit
 * `&& || ??`, conditional expressions, `as`/`satisfies`/`!`/parenthesized
 * unwrapping, a nested `new Type({...})` resource-as-value, and registered
 * lexicon intrinsic tagged templates — is defined ONCE, in {@link "./subset"}
 * ({@link findSubsetViolation}), and shared with EVL001/EVL003
 * ({@link "../lint/rules/evl001-non-literal-expression"}), so the linted
 * subset and the folded subset can never drift apart (#1024).
 *
 * A `CallExpression` has no case — a function call as a value is
 * structurally unrepresentable, not merely linted against. Composite
 * factory calls are out of scope here (epic Phase 5, #1023). Cross-file
 * identifier resolution (imports) is #1020 — single-file only.
 */

/**
 * The result of folding an AST node: a plain value, a symbolic reference to
 * a sibling resource's attribute, a folded intrinsic tagged template, an
 * unresolved external symbol chain, or a folded resource spec.
 */
export type FoldedValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | FoldedValue[]
  | { [key: string]: FoldedValue }
  | AttrRefValue
  | FoldedIntrinsic
  | SymbolicValue
  | FoldedResource;

/**
 * Symbolic reference produced when a property/element access resolves to an
 * attribute of another `const`-declared resource in the same file, e.g.
 * `bucket.name` (or `bucket["name"]`) where `bucket` is
 * `const bucket = new S3Bucket({...})`.
 *
 * This is the SAME envelope `AttrRef.prototype.toJSON()` produces at
 * runtime ({@link "../attrref"}) — `serializer-walker.ts`'s `walkValue`
 * already recognizes a plain `{ __attrRef }` object as an AttrRef envelope
 * (it doesn't require a live `AttrRef` instance), so this is not an
 * invented shape: it's the existing envelope, produced without running the
 * module that would otherwise construct the real `AttrRef`.
 */
export interface AttrRefValue {
  __attrRef: { entity: string; attribute: string };
}

/**
 * The result of folding a registered lexicon intrinsic tagged template
 * (e.g. `Sub\`${AWS.StackName}-x\``) to its node form: tag name, cooked
 * template string parts, and folded interpolated values (in order).
 * Mirrors the runtime call shape `Tag(strings, ...values)` so a later
 * build path can replay it into the real intrinsic object (#1022).
 */
export interface FoldedIntrinsic {
  __intrinsic: string;
  strings: string[];
  values: FoldedValue[];
}

/**
 * A sub-expression inside a folded intrinsic that fold could not reduce to
 * a value without resolving an identifier from outside this file — e.g. an
 * imported pseudo-parameter namespace access like `AWS.StackName`.
 * Cross-file import resolution is #1020; until then the raw source text is
 * preserved verbatim (never stringified, never rejected) instead of being
 * treated as an unresolved-identifier error. Only appears inside a folded
 * intrinsic's `values` — see {@link foldIntrinsicValue}.
 */
export interface SymbolicValue {
  __symbol: string;
}

/**
 * The result of folding a resource constructor: `new Type({ ...props })`.
 */
export interface FoldedResource {
  __resource: string;
  props: { [key: string]: FoldedValue };
  /**
   * The constructor's optional second argument — CFN-style resource-level
   * attributes (`DependsOn`, `Condition`, `DeletionPolicy`,
   * `UpdateReplacePolicy`, `CreationPolicy`, `Metadata`, …) some lexicons
   * accept alongside `props` (see `createResource`'s `attributes` param,
   * ../runtime.ts). Present only when the source actually passed one.
   */
  attributes?: { [key: string]: FoldedValue };
}

/**
 * One entry per exported `const` resource declaration in {@link foldModule}'s
 * result. The `ok: false` case surfaces the same located, rule-id-tagged
 * shape as {@link FoldError} (#1024) — `error` stays the formatted message
 * string for backward-compat display, while `ruleId`/`line`/`column` let a
 * caller cite the exact same rule id + position an EVL diagnostic for the
 * same construct would.
 */
export type FoldModuleEntry =
  | { ok: true; spec: FoldedResource }
  | { ok: false; error: string; ruleId: SubsetRuleId; line: number; column: number };

/**
 * Error thrown when a node cannot be folded to a value without executing
 * code. Carries the node's source position (1-based, matching `LintError`)
 * so callers can report a located diagnostic, and the id of the EVL rule
 * that flags the same construct (#1024) — "EVL001" (the general
 * not-statically-evaluable umbrella) unless the rejection is specifically a
 * dynamic element-access key, which is "EVL003"'s construct. A rejection
 * with no EVL equivalent (unresolved identifier, unregistered intrinsic tag,
 * spread of a value that turns out not to be an object/array — all
 * environment/value-dependent, see {@link "./subset"}'s module doc) still
 * defaults to "EVL001" since that's the closest umbrella rule, even though
 * EVL can't actually detect it ahead of a real fold.
 */
export class FoldError extends Error {
  readonly line: number;
  readonly column: number;
  readonly ruleId: SubsetRuleId;

  constructor(message: string, line: number, column: number, ruleId: SubsetRuleId = "EVL001") {
    super(`${line}:${column} - ${message}`);
    this.name = "FoldError";
    this.line = line;
    this.column = column;
    this.ruleId = ruleId;
  }
}

/** Resolve a node's 1-based line/column via its owning `SourceFile`. */
function locate(node: ts.Node): { line: number; column: number } {
  const sourceFile = node.getSourceFile();
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
  return { line: line + 1, column: character + 1 };
}

function foldError(node: ts.Node, message: string, ruleId: SubsetRuleId = "EVL001"): FoldError {
  const { line, column } = locate(node);
  return new FoldError(message, line, column, ruleId);
}

/**
 * Collect every top-level `const x = <initializer>` in a source file into a
 * name -> initializer map. Single-file only (cross-file is #1020).
 */
export function collectConsts(sourceFile: ts.SourceFile): Map<string, ts.Expression> {
  const consts = new Map<string, ts.Expression>();
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    if ((statement.declarationList.flags & ts.NodeFlags.Const) === 0) continue;
    for (const decl of statement.declarationList.declarations) {
      if (ts.isIdentifier(decl.name) && decl.initializer) {
        consts.set(decl.name.text, decl.initializer);
      }
    }
  }
  return consts;
}

/** A property/element key foldable without execution: identifier, string, or numeric literal. */
function propName(node: ts.PropertyName): string {
  if (isLiteralPropertyName(node)) return node.text;
  throw foldError(node, computedPropertyNameMessage(node));
}

/**
 * An element-access key foldable without execution: a string or numeric
 * LITERAL only (EVL003 semantics — a variable or expression key is a
 * dynamic key and is rejected).
 */
function elementKey(node: ts.Expression): string {
  if (isLiteralElementKey(node)) return node.text;
  throw foldError(node, dynamicElementAccessMessage(node), "EVL003");
}

/** True when `ident` is a `const` bound to a `new Type(...)` resource constructor. */
function resolvesToResource(consts: Map<string, ts.Expression>, ident: ts.Identifier): boolean {
  const init = consts.get(ident.text);
  return init !== undefined && ts.isNewExpression(init);
}

/**
 * True when `node` is an identifier, or a dotted/bracketed access chain
 * rooted at an identifier, that isn't bound in `consts` — e.g.
 * `AWS.StackName` from an imported pseudo-parameter namespace, or a bare
 * imported identifier. Resolving what it actually refers to requires
 * following an import (#1020), which is out of scope here.
 */
function isUnresolvedSymbolChain(node: ts.Expression, consts: Map<string, ts.Expression>): boolean {
  if (ts.isIdentifier(node)) return node.text !== "undefined" && !consts.has(node.text);
  if (ts.isPropertyAccessExpression(node)) return isUnresolvedSymbolChain(node.expression, consts);
  if (ts.isElementAccessExpression(node)) return isUnresolvedSymbolChain(node.expression, consts);
  if (ts.isNonNullExpression(node)) return isUnresolvedSymbolChain(node.expression, consts);
  return false;
}

/**
 * Fold one interpolated sub-expression of a registered intrinsic tagged
 * template. Identical to {@link fold}, except an unresolved external
 * symbol chain (a pseudo-parameter-style access this file can't see the
 * import for) folds to a {@link SymbolicValue} instead of throwing — the
 * run path resolves it once the module actually imports and runs; fold
 * preserves it symbolically rather than stringifying or rejecting it.
 */
function foldIntrinsicValue(
  node: ts.Expression,
  consts: Map<string, ts.Expression>,
  intrinsics: readonly IntrinsicDef[],
): FoldedValue {
  if (isUnresolvedSymbolChain(node, consts)) {
    return { __symbol: node.getText() };
  }
  return fold(node, consts, intrinsics);
}

/**
 * Fold a `TaggedTemplateExpression` whose tag is a registered lexicon
 * intrinsic (`IntrinsicDef.isTag === true`) to its node form. An
 * unregistered tag throws a located {@link FoldError}.
 */
function foldTaggedTemplate(
  node: ts.TaggedTemplateExpression,
  consts: Map<string, ts.Expression>,
  intrinsics: readonly IntrinsicDef[],
): FoldedIntrinsic {
  const tagName = node.tag.getText();
  const isRegistered = intrinsics.some((i) => i.isTag === true && i.name === tagName);
  if (!isRegistered) {
    throw foldError(node, `unregistered tagged template intrinsic: ${tagName}\`...\``);
  }

  const template = node.template;
  if (ts.isNoSubstitutionTemplateLiteral(template)) {
    return { __intrinsic: tagName, strings: [template.text], values: [] };
  }

  const strings = [template.head.text, ...template.templateSpans.map((span) => span.literal.text)];
  const values = template.templateSpans.map((span) => foldIntrinsicValue(span.expression, consts, intrinsics));
  return { __intrinsic: tagName, strings, values };
}

/**
 * Fold a single expression node to a value. Throws {@link FoldError} for
 * anything outside the supported subset — including any `CallExpression`
 * that isn't a registered intrinsic tagged template.
 *
 * @param intrinsics - Lexicon-registered intrinsic tags (`IntrinsicDef`
 *   entries with `isTag: true`, e.g. `Sub`). A tagged template whose tag
 *   isn't in this list is rejected. Defaults to none — pass the target
 *   lexicon's manifest `intrinsics` to recognize its tags.
 */
export function fold(
  node: ts.Expression,
  consts: Map<string, ts.Expression>,
  intrinsics: readonly IntrinsicDef[] = [],
): FoldedValue {
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isNonNullExpression(node)
  ) {
    return fold(node.expression, consts, intrinsics);
  }

  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }

  if (ts.isNumericLiteral(node)) {
    return Number(node.text);
  }

  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;

  if (ts.isIdentifier(node) && node.text === "undefined") return undefined;

  if (ts.isTaggedTemplateExpression(node)) {
    return foldTaggedTemplate(node, consts, intrinsics);
  }

  if (ts.isTemplateExpression(node)) {
    let out = node.head.text;
    for (const span of node.templateSpans) {
      out += String(fold(span.expression, consts, intrinsics)) + span.literal.text;
    }
    return out;
  }

  if (ts.isObjectLiteralExpression(node)) {
    const obj: { [key: string]: FoldedValue } = {};
    for (const prop of node.properties) {
      if (ts.isPropertyAssignment(prop)) {
        obj[propName(prop.name)] = fold(prop.initializer, consts, intrinsics);
      } else if (ts.isShorthandPropertyAssignment(prop)) {
        obj[prop.name.text] = fold(prop.name, consts, intrinsics);
      } else if (ts.isSpreadAssignment(prop)) {
        const src = fold(prop.expression, consts, intrinsics);
        if (src === null || typeof src !== "object") {
          throw foldError(prop, "spread source not an object");
        }
        Object.assign(obj, src);
      } else {
        throw foldError(prop, UNSUPPORTED_OBJECT_MEMBER_MESSAGE);
      }
    }
    return obj;
  }

  if (ts.isArrayLiteralExpression(node)) {
    const arr: FoldedValue[] = [];
    for (const el of node.elements) {
      if (ts.isSpreadElement(el)) {
        const src = fold(el.expression, consts, intrinsics);
        if (!Array.isArray(src)) {
          throw foldError(el, "spread source not an array");
        }
        arr.push(...src);
      } else {
        arr.push(fold(el, consts, intrinsics));
      }
    }
    return arr;
  }

  if (ts.isIdentifier(node)) {
    if (!consts.has(node.text)) {
      throw foldError(node, `unresolved identifier: ${node.text}`);
    }
    return fold(consts.get(node.text) as ts.Expression, consts, intrinsics);
  }

  if (ts.isPropertyAccessExpression(node)) {
    if (ts.isIdentifier(node.expression) && resolvesToResource(consts, node.expression)) {
      return { __attrRef: { entity: node.expression.text, attribute: node.name.text } };
    }
    const obj = fold(node.expression, consts, intrinsics);
    if (obj === null || obj === undefined) return undefined;
    return (obj as { [key: string]: FoldedValue })[node.name.text];
  }

  if (ts.isElementAccessExpression(node)) {
    const key = elementKey(node.argumentExpression);
    if (ts.isIdentifier(node.expression) && resolvesToResource(consts, node.expression)) {
      return { __attrRef: { entity: node.expression.text, attribute: key } };
    }
    const obj = fold(node.expression, consts, intrinsics);
    if (obj === null || obj === undefined) return undefined;
    return (obj as { [key: string]: FoldedValue })[key];
  }

  if (ts.isPrefixUnaryExpression(node)) {
    if (!SUPPORTED_UNARY_OPERATORS.has(node.operator)) {
      throw foldError(node, UNSUPPORTED_UNARY_MESSAGE);
    }
    const value = fold(node.operand, consts, intrinsics);
    if (node.operator === ts.SyntaxKind.ExclamationToken) return !value;
    return -(value as unknown as number); // ts.SyntaxKind.MinusToken — the only other supported operator
  }

  if (ts.isBinaryExpression(node)) {
    const opKind = node.operatorToken.kind;
    const S = ts.SyntaxKind;

    if (opKind === S.AmpersandAmpersandToken) {
      const left = fold(node.left, consts, intrinsics);
      return left ? fold(node.right, consts, intrinsics) : left;
    }
    if (opKind === S.BarBarToken) {
      const left = fold(node.left, consts, intrinsics);
      return left ? left : fold(node.right, consts, intrinsics);
    }
    if (opKind === S.QuestionQuestionToken) {
      const left = fold(node.left, consts, intrinsics);
      return left === null || left === undefined ? fold(node.right, consts, intrinsics) : left;
    }

    if (!SUPPORTED_BINARY_OPERATORS.has(opKind)) {
      throw foldError(node, unsupportedBinaryMessage(opKind));
    }

    const left = fold(node.left, consts, intrinsics);
    const right = fold(node.right, consts, intrinsics);
    switch (opKind) {
      case S.PlusToken:
        return (left as unknown as string) + (right as unknown as string);
      case S.MinusToken:
        return (left as unknown as number) - (right as unknown as number);
      case S.AsteriskToken:
        return (left as unknown as number) * (right as unknown as number);
      case S.SlashToken:
        return (left as unknown as number) / (right as unknown as number);
      case S.EqualsEqualsEqualsToken:
        return left === right;
      case S.ExclamationEqualsEqualsToken:
        return left !== right;
      case S.GreaterThanToken:
        return (left as unknown as string) > (right as unknown as string);
      case S.LessThanToken:
        return (left as unknown as string) < (right as unknown as string);
      case S.GreaterThanEqualsToken:
        return (left as unknown as string) >= (right as unknown as string);
      case S.LessThanEqualsToken:
        return (left as unknown as string) <= (right as unknown as string);
      default:
        // Unreachable given the SUPPORTED_BINARY_OPERATORS guard above —
        // kept as a defensive fallback in case that set and this switch
        // ever fall out of sync.
        throw foldError(node, unsupportedBinaryMessage(opKind));
    }
  }

  if (ts.isConditionalExpression(node)) {
    return fold(node.condition, consts, intrinsics)
      ? fold(node.whenTrue, consts, intrinsics)
      : fold(node.whenFalse, consts, intrinsics);
  }

  if (ts.isNewExpression(node)) {
    // A nested `new Type({...})` used as a property VALUE is not leaf-foldable.
    // fold can only produce the {__resource, props} envelope, and — unlike a
    // TOP-LEVEL resource, which fold-import constructs into a real Declarable —
    // a nested one is never constructed, so the envelope leaks into serialization
    // as the wrong value (real fold-vs-run drift; the #1025 differential caught
    // this on gitlab/multi-stage-deploy, where `new Image({...})` as a job's
    // `image:` must serialize as `{ name }`, not `{ __resource, props }`).
    // Reject so the file falls back to run, which constructs and serializes it
    // correctly. EVL permits this statically — it's a documented fold/EVL
    // divergence, like identifier resolution and spread runtime type.
    throw foldError(node, `nested \`new ${node.expression.getText()}(...)\` as a value is not foldable — falls back to run`);
  }

  if (ts.isCallExpression(node)) {
    throw foldError(node, callExpressionMessage(node));
  }

  throw foldError(node, unsupportedExpressionMessage(node));
}

/**
 * Fold a resource constructor call — `new Type({ ...props }, { ...attributes
 * })` — to its spec. Each argument present must be an object literal
 * (anything else is not statically evaluable and throws a located
 * {@link FoldError}). The second argument (CFN-style resource attributes —
 * `DependsOn`, `Condition`, `DeletionPolicy`, …) is optional, matching
 * `createResource`'s runtime constructor signature (../runtime.ts).
 */
export function foldResource(
  node: ts.NewExpression,
  consts: Map<string, ts.Expression>,
  intrinsics: readonly IntrinsicDef[] = [],
): FoldedResource {
  const typeName = node.expression.getText();
  const [firstArg, secondArg] = node.arguments ?? [];

  if (!firstArg) {
    return { __resource: typeName, props: {} };
  }
  if (!ts.isObjectLiteralExpression(firstArg)) {
    throw foldError(firstArg, resourceCtorArgMessage(typeName));
  }
  const props = fold(firstArg, consts, intrinsics) as { [key: string]: FoldedValue };

  if (!secondArg) {
    return { __resource: typeName, props };
  }
  if (!ts.isObjectLiteralExpression(secondArg)) {
    throw foldError(secondArg, `resource attributes argument must be an object literal: ${typeName}(...)`);
  }
  const attributes = fold(secondArg, consts, intrinsics) as { [key: string]: FoldedValue };
  return { __resource: typeName, props, attributes };
}

function hasExportModifier(statement: ts.VariableStatement): boolean {
  return statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}

/**
 * Fold every exported `const X = new Type({...})` resource declaration in a
 * source file to its spec, with no module execution.
 *
 * Non-resource `const` exports (anything whose initializer isn't a `new`
 * expression) are left out of the result rather than folded or errored —
 * `new`-less resource forms (composite factory calls) are epic Phase 5
 * (#1023) and are not attempted here.
 *
 * @param intrinsics - Lexicon-registered intrinsic tags, forwarded to
 *   {@link fold} for every resource. See {@link fold}'s `intrinsics` param.
 */
export function foldModule(
  source: string,
  fileName = "module.ts",
  intrinsics: readonly IntrinsicDef[] = [],
): Record<string, FoldModuleEntry> {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, /* setParentNodes */ true);
  const consts = collectConsts(sourceFile);
  const result: Record<string, FoldModuleEntry> = {};

  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    if (!hasExportModifier(statement)) continue;
    if ((statement.declarationList.flags & ts.NodeFlags.Const) === 0) continue;

    for (const decl of statement.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;
      if (!ts.isNewExpression(decl.initializer)) continue;

      const name = decl.name.text;
      try {
        const spec = foldResource(decl.initializer, consts, intrinsics);
        result[name] = { ok: true, spec };
      } catch (err) {
        if (err instanceof FoldError) {
          result[name] = { ok: false, error: err.message, ruleId: err.ruleId, line: err.line, column: err.column };
        } else {
          throw err;
        }
      }
    }
  }

  return result;
}
