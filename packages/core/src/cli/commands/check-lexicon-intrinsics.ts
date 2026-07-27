/**
 * Static audit of a lexicon's intrinsic registrations (chant #1067).
 *
 * `check-lexicon.ts`'s original 29 checks are all existence/count assertions
 * — they never look at whether a registration is actually *correct*.
 * Foldability (`IntrinsicDef.isTag`, ../../lexicon.ts) is the sharpest case:
 * it drives both `chant build --fold` (which registered tags it recognizes)
 * and the generated per-lexicon intrinsics doc page (its "Folds?" column,
 * via `intrinsicFolds()`), so a wrong value doesn't just mislead a reader —
 * it silently changes what `--fold` does. #1039 shipped with the flag wrong
 * in both directions at once (aws's `Sub` missing `isTag` entirely; gitlab's
 * `reference()` claiming `isTag: true` for a plain call) and neither was
 * caught by anything until someone measured fold coverage by hand.
 *
 * This module answers two questions per registered intrinsic, purely by
 * parsing source (no execution, no `chant generate` required first):
 *
 * 1. Is `name` actually exported from the package's public entry
 *    (`src/index.ts`)? A registration that names something the package
 *    doesn't export is documenting a function that doesn't exist.
 * 2. Does the exported declaration's own shape agree with `isTag`? A tagged
 *    template is a function whose first parameter is typed
 *    `TemplateStringsArray` — the only shape `fold()` ever recognizes as a
 *    tag (see ../../fold/fold.ts). Anything else (a plain function, a class,
 *    a const object/proxy) cannot be invoked as `` Name`...` `` and must be
 *    `isTag: false`.
 *
 * chant #1044 adds a third question, for the same reason the first two
 * exist: `foldsAsCall` opts an intrinsic's PLAIN-CALL form into folding, so
 * declaring it on something authored as a tagged template claims a form that
 * cannot be called that way. The two flags are mutually exclusive, and a
 * registration setting both is a failure here rather than a silently ignored
 * field.
 */

import { existsSync, readFileSync } from "fs";
import { join, dirname } from "path";
import * as ts from "typescript";

// ── Types ────────────────────────────────────────────────────────────

export interface IntrinsicAuditItem {
  name: string;
  /** The `isTag` value as registered in `src/plugin.ts`'s `intrinsics()`. */
  declaredIsTag: boolean | undefined;
  /** The `foldsAsCall` opt-in as registered in `src/plugin.ts` (chant #1044); `undefined` when absent, which means "not opted in". */
  declaredFoldsAsCall: boolean | undefined;
  /** Whether `name` resolves to a real export of `src/index.ts`. */
  exported: boolean;
  /**
   * Whether the resolved declaration is genuinely authored as a tagged
   * template (first parameter typed `TemplateStringsArray`). `undefined`
   * when the declaration couldn't be located or its shape can't be
   * determined statically — treated as a failure, not a pass, since a
   * foldability claim that can't be verified is exactly the unvalidated
   * state #1067 is closing.
   */
  actualIsTag: boolean | undefined;
  /** True only when exported AND the authored shape matches `declaredIsTag`. */
  ok: boolean;
  detail?: string;
  /**
   * chant #1044 — false only when `foldsAsCall: true` is registered on
   * something authored as a tagged template. Tracked separately from
   * {@link ok} so the two failures report as the two different registration
   * mistakes they are, rather than one message covering both.
   */
  callFormOk: boolean;
  callFormDetail?: string;
}

interface DeclaredIntrinsic {
  name: string;
  isTag: boolean | undefined;
  foldsAsCall: boolean | undefined;
}

interface ExportTarget {
  /** Relative module specifier as written, e.g. "./intrinsics". */
  modulePath: string;
  /** The name as declared in the target module (post `as` rename resolution). */
  localName: string;
}

// ── Parsing helpers ──────────────────────────────────────────────────

function parseFile(path: string): ts.SourceFile | undefined {
  if (!existsSync(path)) return undefined;
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch {
    return undefined;
  }
  return ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

/**
 * Find `intrinsics(): IntrinsicDef[] { return [ ... ]; }` (or the arrow-
 * function-property equivalent) in a plugin.ts source file and extract each
 * registered `{ name, isTag, foldsAsCall }` triple from the array literal. Returns
 * `undefined` when no `intrinsics` method exists at all (lexicons with no
 * intrinsics, e.g. gcp/k8s, still return `[]` — that's a real empty array,
 * not `undefined`).
 */
function extractDeclaredIntrinsics(pluginPath: string): DeclaredIntrinsic[] | undefined {
  const sf = parseFile(pluginPath);
  if (!sf) return undefined;

  let arrayLiteral: ts.ArrayLiteralExpression | undefined;

  const findReturnedArray = (body: ts.Block): ts.ArrayLiteralExpression | undefined => {
    for (const stmt of body.statements) {
      if (ts.isReturnStatement(stmt) && stmt.expression && ts.isArrayLiteralExpression(stmt.expression)) {
        return stmt.expression;
      }
    }
    return undefined;
  };

  const visit = (node: ts.Node): void => {
    if (arrayLiteral) return;

    if (ts.isMethodDeclaration(node) && node.name && ts.isIdentifier(node.name) && node.name.text === "intrinsics" && node.body) {
      arrayLiteral = findReturnedArray(node.body);
    } else if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && node.name.text === "intrinsics") {
      const init = node.initializer;
      if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
        if (init.body && ts.isBlock(init.body)) {
          arrayLiteral = findReturnedArray(init.body);
        } else if (init.body && ts.isArrayLiteralExpression(init.body)) {
          arrayLiteral = init.body;
        }
      }
    }

    if (!arrayLiteral) ts.forEachChild(node, visit);
  };
  visit(sf);

  if (!arrayLiteral) return undefined;

  const result: DeclaredIntrinsic[] = [];
  for (const el of arrayLiteral.elements) {
    if (!ts.isObjectLiteralExpression(el)) continue;
    let name: string | undefined;
    let isTag: boolean | undefined;
    let foldsAsCall: boolean | undefined;

    for (const prop of el.properties) {
      if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) continue;
      const key = prop.name.text;
      if (key === "name" && ts.isStringLiteralLike(prop.initializer)) {
        name = prop.initializer.text;
      } else if (key === "isTag") {
        if (prop.initializer.kind === ts.SyntaxKind.TrueKeyword) isTag = true;
        else if (prop.initializer.kind === ts.SyntaxKind.FalseKeyword) isTag = false;
      } else if (key === "foldsAsCall") {
        if (prop.initializer.kind === ts.SyntaxKind.TrueKeyword) foldsAsCall = true;
        else if (prop.initializer.kind === ts.SyntaxKind.FalseKeyword) foldsAsCall = false;
      }
    }

    if (name !== undefined) result.push({ name, isTag, foldsAsCall });
  }

  return result;
}

/**
 * Build a map of publicly-exported name -> where it's really declared, by
 * parsing `src/index.ts`'s top-level `export { a, b as c } from "./file"`
 * statements (every lexicon's intrinsics are re-exported this way) plus
 * direct top-level exported declarations in index.ts itself (`modulePath:
 * "."`). Wildcard re-exports (`export * from "./generated"`) are not
 * expanded — none of the 8 lexicons that register intrinsics export them
 * that way, so this is a deliberate, documented gap rather than a silent one.
 */
function extractExportMap(indexPath: string): Map<string, ExportTarget> {
  const map = new Map<string, ExportTarget>();
  const sf = parseFile(indexPath);
  if (!sf) return map;

  const hasExportModifier = (node: ts.Node): boolean =>
    !!ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);

  for (const stmt of sf.statements) {
    if (ts.isExportDeclaration(stmt) && stmt.moduleSpecifier && ts.isStringLiteralLike(stmt.moduleSpecifier)) {
      const modulePath = stmt.moduleSpecifier.text;
      if (stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
        for (const spec of stmt.exportClause.elements) {
          const exportedName = spec.name.text;
          const localName = spec.propertyName ? spec.propertyName.text : exportedName;
          map.set(exportedName, { modulePath, localName });
        }
      }
      continue;
    }

    if (ts.isFunctionDeclaration(stmt) && stmt.name && hasExportModifier(stmt)) {
      map.set(stmt.name.text, { modulePath: ".", localName: stmt.name.text });
    } else if (ts.isClassDeclaration(stmt) && stmt.name && hasExportModifier(stmt)) {
      map.set(stmt.name.text, { modulePath: ".", localName: stmt.name.text });
    } else if (ts.isVariableStatement(stmt) && hasExportModifier(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) {
          map.set(decl.name.text, { modulePath: ".", localName: decl.name.text });
        }
      }
    }
  }

  return map;
}

/** True when a parameter list's first entry is typed `TemplateStringsArray`. */
function firstParamIsTemplateStringsArray(params: ts.NodeArray<ts.ParameterDeclaration>): boolean {
  const first = params[0];
  if (!first?.type || !ts.isTypeReferenceNode(first.type)) return false;
  const typeName = first.type.typeName;
  const text = ts.isIdentifier(typeName) ? typeName.text : typeName.right.text;
  return text === "TemplateStringsArray";
}

/**
 * Resolve whether the declaration named `target.localName` in the module
 * `target.modulePath` (relative to `indexPath`) is authored as a tagged
 * template. Returns `{ found: false }` when the declaration can't be
 * located — a function declared but never found is treated as unverifiable,
 * not as a pass.
 */
function resolveActualIsTag(
  indexPath: string,
  target: ExportTarget,
): { found: boolean; isTag?: boolean } {
  const filePath =
    target.modulePath === "."
      ? indexPath
      : join(dirname(indexPath), `${target.modulePath.replace(/^\.\//, "")}.ts`);

  const sf = parseFile(filePath);
  if (!sf) return { found: false };

  let result: { found: boolean; isTag?: boolean } | undefined;

  for (const stmt of sf.statements) {
    if (result) break;

    if (ts.isFunctionDeclaration(stmt) && stmt.name?.text === target.localName) {
      result = { found: true, isTag: firstParamIsTemplateStringsArray(stmt.parameters) };
    } else if (ts.isClassDeclaration(stmt) && stmt.name?.text === target.localName) {
      // A class is invoked with `new X(...)`, never as a tagged template.
      result = { found: true, isTag: false };
    } else if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name) || decl.name.text !== target.localName) continue;
        const init = decl.initializer;
        if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
          result = { found: true, isTag: firstParamIsTemplateStringsArray(init.parameters) };
        } else {
          // A const object, proxy, `new X()`, etc. — not callable as a tag.
          result = { found: true, isTag: false };
        }
      }
    }
  }

  return result ?? { found: false };
}

// ── Public entry point ───────────────────────────────────────────────

/**
 * Audit every intrinsic a lexicon registers in `src/plugin.ts` against
 * `src/index.ts`'s real export surface and each export's authored shape.
 * Returns `[]` for a lexicon with no `intrinsics()` method, or one that
 * registers none — nothing to audit either way.
 */
export function auditIntrinsics(lexiconDir: string): IntrinsicAuditItem[] {
  const pluginPath = join(lexiconDir, "src/plugin.ts");
  const indexPath = join(lexiconDir, "src/index.ts");

  const declared = extractDeclaredIntrinsics(pluginPath);
  if (!declared || declared.length === 0) return [];

  const exportMap = extractExportMap(indexPath);
  const items: IntrinsicAuditItem[] = [];

  for (const d of declared) {
    const target = exportMap.get(d.name);

    if (!target) {
      items.push({
        name: d.name,
        declaredIsTag: d.isTag,
        declaredFoldsAsCall: d.foldsAsCall,
        exported: false,
        actualIsTag: undefined,
        ok: false,
        detail: `"${d.name}" is registered in plugin.ts intrinsics() but is not exported from src/index.ts`,
        callFormOk: true,
      });
      continue;
    }

    const resolved = resolveActualIsTag(indexPath, target);
    if (!resolved.found) {
      items.push({
        name: d.name,
        declaredIsTag: d.isTag,
        declaredFoldsAsCall: d.foldsAsCall,
        exported: true,
        actualIsTag: undefined,
        ok: false,
        detail: `could not locate the declaration of "${d.name}" (exported from ${target.modulePath}) to verify it against isTag`,
        callFormOk: true,
      });
      continue;
    }

    const declaredTag = d.isTag === true;
    const ok = resolved.isTag === declaredTag;
    // chant #1044 — `foldsAsCall` opts the PLAIN-CALL form in, so it is
    // meaningless (and, if honored, wrong) on a tagged template. Judged
    // against how the export is really authored, not against the sibling
    // `isTag` claim, which may itself be the thing that's wrong.
    const callFormOk = !(d.foldsAsCall === true && resolved.isTag === true);
    items.push({
      name: d.name,
      declaredIsTag: d.isTag,
      declaredFoldsAsCall: d.foldsAsCall,
      exported: true,
      actualIsTag: resolved.isTag,
      ok,
      callFormOk,
      callFormDetail: callFormOk
        ? undefined
        : `"${d.name}" is authored as a tagged template but registered with foldsAsCall: true — the call-form opt-in applies to plain-call intrinsics only`,
      detail: ok
        ? undefined
        : resolved.isTag
          ? `"${d.name}" is authored as a tagged template (first param: TemplateStringsArray) but registered with isTag: ${d.isTag ?? "undefined"}`
          : `"${d.name}" is a plain call/declaration (not a tagged template) but registered with isTag: true`,
    });
  }

  return items;
}
