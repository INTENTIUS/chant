import * as ts from "typescript";
import type { LintRule, LintContext, LintDiagnostic } from "../rule";
import { receiptFactoryCall } from "./cor022-receipt-leaf";

/**
 * COR024: Receipt Inputs Reference Secrets by Pointer (#1833, epic #1703;
 * composes with the secret-provenance work, #1365/#1828)
 *
 * A receipt's `inputs` feed its expectation hash (../../effect-receipt.ts) —
 * whatever lands there is canonicalized, digested, and compared against a
 * stored value for the rest of the receipt's life. chant's constitutional
 * line on secrets is that no code path may hold, log, hash, or compare a
 * secret value (../../secret-provenance.ts), so a receipt input that reads a
 * Secret-kind entity's material (`.data`, `.value`, `.stringData`, ...)
 * violates it twice over: the material enters the hash, and the serialized
 * placeholder ties the receipt to the secret's value rather than its
 * identity.
 *
 * The pointer form is fine — and is the point: reference the secret by name
 * and version (`{ secretName: dbSecret.name, secretVersion: 3 }`), so a
 * rotation is an explicit version bump that re-proposes the effect, and the
 * hash only ever sees the pointer.
 *
 * Recognition is the same file-local reference walk COR022 uses (const
 * indirection included): a variable is Secret-kind when its initializer is a
 * constructor or factory whose name says so (`new SecretManagerSecret(...)`,
 * `new ExternalSecret(...)`, `declareSecret(...)`); an input fires when a
 * property chain rooted at one of those crosses a material field.
 */

/** Fields that carry secret material. Mirrors secret-provenance.ts's
 * FORBIDDEN_MATERIAL_FIELDS, plus the provider-attribute spellings
 * (`secretString`/`secretValue`) a materialized secret exposes. */
const MATERIAL_FIELDS = new Set([
  "value",
  "data",
  "stringdata",
  "material",
  "plaintext",
  "ciphertext",
  "secretstring",
  "secretvalue",
]);

function isMaterialField(name: string): boolean {
  return MATERIAL_FIELDS.has(name.toLowerCase());
}

/** Simple name of a `new X(...)` / `X(...)` / `ns.X(...)` initializer. */
function initializerName(init: ts.Expression): string | undefined {
  if (!ts.isNewExpression(init) && !ts.isCallExpression(init)) return undefined;
  const callee = init.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return undefined;
}

/** Does this constructor/factory name declare a Secret-kind entity? */
function isSecretKindName(name: string): boolean {
  return /secret/i.test(name) || name === "declareSecret";
}

/** One access chain: `sec.data.password` → root "sec", segments ["data","password"]. */
function decomposeChain(
  node: ts.Expression,
): { root: string; segments: string[] } | undefined {
  const segments: string[] = [];
  let current: ts.Expression = node;
  while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    if (ts.isPropertyAccessExpression(current)) {
      segments.unshift(current.name.text);
    } else {
      const arg = current.argumentExpression;
      segments.unshift(ts.isStringLiteralLike(arg) ? arg.text : "<computed>");
    }
    current = current.expression;
  }
  if (!ts.isIdentifier(current)) return undefined;
  return { root: current.text, segments };
}

interface SecretVars {
  /** Variables holding a Secret-kind entity (or an alias of one). */
  secretRooted: Set<string>;
  /** Variables that already crossed a material field (`const m = sec.data`). */
  material: Set<string>;
}

/** File-local Secret-kind variables, aliases and material extractions, to a fixpoint. */
function collectSecretVariables(sourceFile: ts.SourceFile): SecretVars {
  const secretRooted = new Set<string>();
  const material = new Set<string>();
  const derived: Array<{ name: string; root: string; crossesMaterial: boolean; isBareAlias: boolean }> = [];

  function visit(node: ts.Node): void {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const init = node.initializer;
      const ctorName = initializerName(init);
      if (ctorName !== undefined && isSecretKindName(ctorName)) {
        secretRooted.add(node.name.text);
      } else if (ts.isIdentifier(init)) {
        derived.push({ name: node.name.text, root: init.text, crossesMaterial: false, isBareAlias: true });
      } else if (ts.isPropertyAccessExpression(init) || ts.isElementAccessExpression(init)) {
        const chain = decomposeChain(init);
        if (chain) {
          derived.push({
            name: node.name.text,
            root: chain.root,
            crossesMaterial: chain.segments.some(isMaterialField),
            isBareAlias: false,
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);

  let grew = true;
  while (grew) {
    grew = false;
    for (const d of derived) {
      const rootIsSecret = secretRooted.has(d.root);
      const rootIsMaterial = material.has(d.root);
      if (!rootIsSecret && !rootIsMaterial) continue;
      const target = rootIsMaterial || d.crossesMaterial ? material : secretRooted;
      if (d.isBareAlias && !d.crossesMaterial && rootIsSecret) {
        if (!secretRooted.has(d.name)) {
          secretRooted.add(d.name);
          grew = true;
        }
      } else if (!target.has(d.name)) {
        target.add(d.name);
        grew = true;
      }
    }
  }
  return { secretRooted, material };
}

export const cor024ReceiptSecretPointerRule: LintRule = {
  id: "COR024",
  severity: "error",
  category: "correctness",
  description:
    "A receipt's inputs may reference a secret only by name+version pointer, never by value — secret material must not enter the expectation hash",
  check(context: LintContext): LintDiagnostic[] {
    const diagnostics: LintDiagnostic[] = [];
    const secrets = collectSecretVariables(context.sourceFile);
    if (secrets.secretRooted.size === 0 && secrets.material.size === 0) return diagnostics;

    const report = (node: ts.Node, rendered: string, root: string): void => {
      const { line, character } = context.sourceFile.getLineAndCharacterOfPosition(
        node.getStart(context.sourceFile),
      );
      diagnostics.push({
        file: context.filePath,
        line: line + 1,
        column: character + 1,
        ruleId: "COR024",
        severity: "error",
        message:
          `Receipt input reads secret material (${rendered}) from "${root}" — a receipt's inputs may ` +
          `reference a secret only by name+version pointer, never by value: the inputs are hashed into ` +
          `the receipt's expectation, and no chant code path may hash or compare secret material. ` +
          `Use the pointer form instead, e.g. { secretName: ${root}.name, secretVersion: 3 } — ` +
          `a rotation then re-proposes the effect through an explicit version bump.`,
      });
    };

    const checkInputs = (inputs: ts.Expression): void => {
      const visit = (node: ts.Node): void => {
        if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
          const chain = decomposeChain(node);
          if (chain) {
            const rootMaterial = secrets.material.has(chain.root);
            const crossesMaterial = chain.segments.some(isMaterialField);
            if (rootMaterial || (secrets.secretRooted.has(chain.root) && crossesMaterial)) {
              report(node, `\`${chain.root}.${chain.segments.join(".")}\``, chain.root);
              return; // one diagnostic per chain, not one per link
            }
          }
        } else if (ts.isIdentifier(node) && secrets.material.has(node.text)) {
          const parent = node.parent;
          const isChainBase =
            (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) &&
            parent.expression === node;
          const isKey = ts.isPropertyAssignment(parent) && parent.name === node;
          if (!isChainBase && !isKey) report(node, `\`${node.text}\``, node.text);
        }
        ts.forEachChild(node, visit);
      };
      visit(inputs);
    };

    const walk = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node)) {
        const call = receiptFactoryCall(node);
        const options = call?.arguments[1];
        if (options && ts.isObjectLiteralExpression(options)) {
          for (const prop of options.properties) {
            if (
              ts.isPropertyAssignment(prop) &&
              (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name)) &&
              prop.name.text === "inputs"
            ) {
              checkInputs(prop.initializer);
            }
          }
        }
      }
      ts.forEachChild(node, walk);
    };
    walk(context.sourceFile);

    return diagnostics;
  },
};
