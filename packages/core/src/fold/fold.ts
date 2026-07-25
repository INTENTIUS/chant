import * as ts from "typescript";
import type { IntrinsicDef } from "../lexicon";

/**
 * fold — static AST value reducer (chant #1026/#1021, part of epic #1019)
 *
 * Reduces a single-file TypeScript expression AST to a value with NO
 * module execution. Covers exactly the subset that EVL001/003/004 already
 * permit: literals, template interpolation, object/array literals (incl.
 * spread), `const` identifier resolution, property and element access
 * (incl. the cross-resource `{ __attrRef }` case, literal-key-only), unary
 * `!`/`-`, the binary operators `+ - * / === !== > < >= <=`, short-circuit
 * `&& || ??`, conditional expressions, `as`/`satisfies`/parenthesized
 * unwrapping, and registered lexicon intrinsic tagged templates.
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

/** One entry per exported `const` resource declaration in {@link foldModule}'s result. */
export type FoldModuleEntry =
  | { ok: true; spec: FoldedResource }
  | { ok: false; error: string };

/**
 * Error thrown when a node cannot be folded to a value without executing
 * code. Carries the node's source position (1-based, matching `LintError`)
 * so callers can report a located diagnostic.
 */
export class FoldError extends Error {
  readonly line: number;
  readonly column: number;

  constructor(message: string, line: number, column: number) {
    super(`${line}:${column} - ${message}`);
    this.name = "FoldError";
    this.line = line;
    this.column = column;
  }
}

/** Resolve a node's 1-based line/column via its owning `SourceFile`. */
function locate(node: ts.Node): { line: number; column: number } {
  const sourceFile = node.getSourceFile();
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
  return { line: line + 1, column: character + 1 };
}

function foldError(node: ts.Node, message: string): FoldError {
  const { line, column } = locate(node);
  return new FoldError(message, line, column);
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
  if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)) {
    return node.text;
  }
  throw foldError(node, `computed/dynamic property name not foldable: ${node.getText()}`);
}

/**
 * An element-access key foldable without execution: a string or numeric
 * LITERAL only (EVL003 semantics — a variable or expression key is a
 * dynamic key and is rejected).
 */
function elementKey(node: ts.Expression): string {
  if (ts.isStringLiteral(node) || ts.isNumericLiteral(node)) {
    return node.text;
  }
  throw foldError(
    node,
    `dynamic property access — computed key must be a string or numeric literal: ${node.getText()}`,
  );
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
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) {
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
        throw foldError(prop, "unsupported object member");
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
    const value = fold(node.operand, consts, intrinsics);
    if (node.operator === ts.SyntaxKind.ExclamationToken) return !value;
    if (node.operator === ts.SyntaxKind.MinusToken) return -(value as unknown as number);
    throw foldError(node, "unsupported unary");
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
        throw foldError(node, `unsupported binary operator: ${ts.SyntaxKind[opKind]}`);
    }
  }

  if (ts.isConditionalExpression(node)) {
    return fold(node.condition, consts, intrinsics)
      ? fold(node.whenTrue, consts, intrinsics)
      : fold(node.whenFalse, consts, intrinsics);
  }

  if (ts.isCallExpression(node)) {
    throw foldError(node, `function call as a value is not foldable: ${node.expression.getText()}(...)`);
  }

  throw foldError(node, `unsupported expression: ${ts.SyntaxKind[node.kind]}`);
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
    throw foldError(firstArg, `resource constructor argument must be an object literal: ${typeName}(...)`);
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
          result[name] = { ok: false, error: err.message };
        } else {
          throw err;
        }
      }
    }
  }

  return result;
}
