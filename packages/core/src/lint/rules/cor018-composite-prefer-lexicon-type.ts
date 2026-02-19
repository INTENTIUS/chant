import * as ts from "typescript";
import type { LintRule, LintContext, LintDiagnostic } from "../rule";
import { isCompositeCallee } from "./composite-scope";

/**
 * COR018: Prefer lexicon property types in Composite props
 *
 * Composite prop interfaces should use lexicon property types (via the barrel)
 * instead of locally-declared interfaces or type aliases. Local types next to
 * a Composite definition often duplicate existing lexicon property types.
 *
 * Triggers on: interface with fields used as a Composite prop type, declared
 *              in the same file as the Composite (excluding the props interface itself)
 * OK: InstanceType<typeof _.Role_Policy>
 * OK: primitives (string, number, boolean)
 * OK: barrel-imported types
 */

/**
 * Find all Composite() calls and extract their props type names.
 */
function findCompositePropsTypes(sourceFile: ts.SourceFile): Set<string> {
  const propsTypes = new Set<string>();

  function walk(node: ts.Node): void {
    if (ts.isCallExpression(node) && isCompositeCallee(node.expression)) {
      // Composite<PropsType>(...) — extract from type arguments
      if (node.typeArguments && node.typeArguments.length > 0) {
        const typeArg = node.typeArguments[0];
        if (ts.isTypeReferenceNode(typeArg) && ts.isIdentifier(typeArg.typeName)) {
          propsTypes.add(typeArg.typeName.text);
        }
      }
    }
    ts.forEachChild(node, walk);
  }

  walk(sourceFile);
  return propsTypes;
}

/**
 * Find all locally-declared interface and type alias names.
 */
function findLocalTypeDeclarations(sourceFile: ts.SourceFile): Map<string, ts.Node> {
  const types = new Map<string, ts.Node>();

  function walk(node: ts.Node): void {
    if (ts.isInterfaceDeclaration(node)) {
      types.set(node.name.text, node);
    } else if (ts.isTypeAliasDeclaration(node)) {
      types.set(node.name.text, node);
    }
    ts.forEachChild(node, walk);
  }

  walk(sourceFile);
  return types;
}

/**
 * Collect type references used in a props interface's field types.
 * Returns names of locally-referenced types (not primitives, not from barrel).
 */
function collectFieldTypeRefs(
  propsDecl: ts.Node,
  localTypes: Map<string, ts.Node>,
): Map<string, { fieldName: string; typeNode: ts.Node }> {
  const refs = new Map<string, { fieldName: string; typeNode: ts.Node }>();

  if (!ts.isInterfaceDeclaration(propsDecl)) return refs;

  for (const member of propsDecl.members) {
    if (!ts.isPropertySignature(member) || !member.type) continue;

    const fieldName = ts.isIdentifier(member.name!) ? member.name!.text : "<computed>";
    collectTypeRefsFromNode(member.type, localTypes, fieldName, refs);
  }

  return refs;
}

function collectTypeRefsFromNode(
  node: ts.TypeNode,
  localTypes: Map<string, ts.Node>,
  fieldName: string,
  refs: Map<string, { fieldName: string; typeNode: ts.Node }>,
): void {
  if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)) {
    const name = node.typeName.text;
    if (localTypes.has(name) && !refs.has(name)) {
      refs.set(name, { fieldName, typeNode: node });
    }
  }

  // Recurse into array types: CustomType[] → CustomType
  if (ts.isArrayTypeNode(node)) {
    collectTypeRefsFromNode(node.elementType, localTypes, fieldName, refs);
  }

  // Recurse into union/intersection types
  if (ts.isUnionTypeNode(node) || ts.isIntersectionTypeNode(node)) {
    for (const member of node.types) {
      collectTypeRefsFromNode(member, localTypes, fieldName, refs);
    }
  }

  // Recurse into generic type arguments
  if (ts.isTypeReferenceNode(node) && node.typeArguments) {
    for (const arg of node.typeArguments) {
      collectTypeRefsFromNode(arg, localTypes, fieldName, refs);
    }
  }
}

function checkFile(context: LintContext): LintDiagnostic[] {
  const diagnostics: LintDiagnostic[] = [];
  const { sourceFile } = context;

  // Find Composite calls and their props types
  const propsTypeNames = findCompositePropsTypes(sourceFile);
  if (propsTypeNames.size === 0) return diagnostics;

  // Find all local type declarations
  const localTypes = findLocalTypeDeclarations(sourceFile);

  for (const propsTypeName of propsTypeNames) {
    const propsDecl = localTypes.get(propsTypeName);
    if (!propsDecl) continue;

    // Find local types referenced in the props fields
    // Exclude the props interface itself
    const otherLocalTypes = new Map(localTypes);
    otherLocalTypes.delete(propsTypeName);

    if (otherLocalTypes.size === 0) continue;

    const fieldRefs = collectFieldTypeRefs(propsDecl, otherLocalTypes);

    for (const [typeName, { fieldName, typeNode }] of fieldRefs) {
      const typeDecl = localTypes.get(typeName)!;
      const { line, character } = context.sourceFile.getLineAndCharacterOfPosition(
        typeDecl.getStart(context.sourceFile),
      );

      diagnostics.push({
        file: context.filePath,
        line: line + 1,
        column: character + 1,
        ruleId: "COR018",
        severity: "info",
        message: `Local type "${typeName}" is used in Composite prop "${fieldName}" — consider using a lexicon property type instead (e.g., InstanceType<typeof _.PropertyType>)`,
      });
    }
  }

  return diagnostics;
}

export const cor018CompositePreferLexiconTypeRule: LintRule = {
  id: "COR018",
  severity: "info",
  category: "style",
  check(context: LintContext): LintDiagnostic[] {
    return checkFile(context);
  },
};
