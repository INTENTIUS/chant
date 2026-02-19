import * as ts from "typescript";

/**
 * A selector function that extracts matching nodes from a source file.
 */
export type SelectorFn = (sourceFile: ts.SourceFile) => ts.Node[];

/**
 * Registry of named selectors.
 */
const selectorRegistry = new Map<string, SelectorFn>();

/**
 * Recursively collect nodes matching a predicate.
 */
export function collectNodes(root: ts.Node, predicate: (node: ts.Node) => boolean): ts.Node[] {
  const results: ts.Node[] = [];
  function visit(node: ts.Node): void {
    if (predicate(node)) {
      results.push(node);
    }
    ts.forEachChild(node, visit);
  }
  visit(root);
  return results;
}

/**
 * Built-in selector: matches `new X(...)` constructor calls (resource instantiations).
 */
function selectResource(sf: ts.SourceFile): ts.Node[] {
  return collectNodes(sf, (node) => ts.isNewExpression(node));
}

/**
 * Built-in selector: matches any resource — alias for `resource`.
 */
function selectAnyResource(sf: ts.SourceFile): ts.Node[] {
  return selectResource(sf);
}

/**
 * Built-in selector: matches string literal nodes.
 */
function selectStringLiteral(sf: ts.SourceFile): ts.Node[] {
  return collectNodes(sf, (node) => ts.isStringLiteral(node));
}

/**
 * Built-in selector: matches exported declaration names.
 */
function selectExportName(sf: ts.SourceFile): ts.Node[] {
  return collectNodes(sf, (node) => {
    if (ts.isVariableStatement(node)) {
      return node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
    }
    if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) {
      return node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
    }
    return false;
  });
}

/**
 * Built-in selector: matches import source strings.
 */
function selectImportSource(sf: ts.SourceFile): ts.Node[] {
  return collectNodes(sf, (node) => {
    if (ts.isImportDeclaration(node)) {
      return true;
    }
    return false;
  });
}

/**
 * Built-in selector: matches property assignments.
 */
function selectProperty(sf: ts.SourceFile): ts.Node[] {
  return collectNodes(sf, (node) => ts.isPropertyAssignment(node));
}

/**
 * Built-in selector: matches the type argument of `new X<Type>(...)` expressions.
 */
function selectResourceType(sf: ts.SourceFile): ts.Node[] {
  return collectNodes(sf, (node) => {
    if (ts.isNewExpression(node) && node.typeArguments && node.typeArguments.length > 0) {
      return true;
    }
    return false;
  });
}

/**
 * Built-in selector: matches exported const declarations.
 */
function selectExportedConst(sf: ts.SourceFile): ts.Node[] {
  return collectNodes(sf, (node) => {
    if (!ts.isVariableStatement(node)) return false;
    const hasExport = node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
    if (!hasExport) return false;
    return node.declarationList.flags === ts.NodeFlags.Const ||
      (node.declarationList.flags & ts.NodeFlags.Const) !== 0;
  });
}

// Register built-in selectors
const builtins: [string, SelectorFn][] = [
  ["resource", selectResource],
  ["any-resource", selectAnyResource],
  ["string-literal", selectStringLiteral],
  ["export-name", selectExportName],
  ["import-source", selectImportSource],
  ["property", selectProperty],
  ["resource-type", selectResourceType],
  ["exported-const", selectExportedConst],
];

for (const [name, fn] of builtins) {
  selectorRegistry.set(name, fn);
}

/**
 * Register a custom selector.
 */
export function registerSelector(name: string, fn: SelectorFn): void {
  selectorRegistry.set(name, fn);
}

/**
 * Resolve a selector name (or compound expression) to a SelectorFn.
 *
 * Compound selectors use `>` to scope: `"resource > property"` means
 * "find all `resource` nodes, then within each, find all `property` nodes".
 */
export function resolveSelector(name: string): SelectorFn {
  // Check for compound selector
  if (name.includes(">")) {
    const parts = name.split(">").map((s) => s.trim());
    const fns = parts.map((part) => {
      const fn = selectorRegistry.get(part);
      if (!fn) {
        throw new Error(`Unknown selector: "${part}"`);
      }
      return fn;
    });

    return (sf: ts.SourceFile): ts.Node[] => {
      // Start with results from first selector
      let nodes = fns[0](sf);

      // For each subsequent selector, search within current nodes
      for (let i = 1; i < fns.length; i++) {
        const nextNodes: ts.Node[] = [];
        for (const parent of nodes) {
          const childSelector = fns[i];
          const allMatches = childSelector(sf);
          for (const match of allMatches) {
            if (isDescendantOf(match, parent)) {
              nextNodes.push(match);
            }
          }
        }
        nodes = nextNodes;
      }
      return nodes;
    };
  }

  const fn = selectorRegistry.get(name);
  if (!fn) {
    throw new Error(`Unknown selector: "${name}"`);
  }
  return fn;
}

/**
 * Check if a node is a descendant of another node.
 */
function isDescendantOf(node: ts.Node, ancestor: ts.Node): boolean {
  let current = node.parent;
  while (current) {
    if (current === ancestor) return true;
    current = current.parent;
  }
  return false;
}
