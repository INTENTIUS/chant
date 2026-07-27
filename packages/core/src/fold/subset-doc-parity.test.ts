import { describe, test, expect } from "vitest";
import * as ts from "typescript";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { join } from "path";
import { collectConsts } from "./fold";
import { findSubsetViolation } from "./subset";

/**
 * subset-doc-parity.test.ts — chant #1062 (epic #1019).
 *
 * `docs/.../concepts/typescript-as-data.mdx`'s "Supported Patterns" and
 * "Unsupported Patterns" sections are prose over `findSubsetViolation`
 * (./subset.ts), the real, code-defined classifier. #1062 exists because
 * that prose already drifted from the code once (see subset.ts's own
 * module doc, and #1061's fix) and nothing stopped it.
 *
 * Full generation was considered and rejected: `findSubsetViolation` is a
 * recursive-descent classifier over `ts.Node` kinds, not a flat table — its
 * value is precisely the nuance a table would lose (flow-insensitive
 * short-circuit handling, opaque tagged-template interiors, which EVL rule
 * id a rejection maps to, …). Mechanically reverse-engineering that nuance
 * from the function body would mean either emitting a bare list of
 * `ts.SyntaxKind` names (useless to a reader) or writing a second, brittle
 * introspector that breaks on any harmless refactor of subset.ts — a worse
 * failure mode than the one this issue exists to fix.
 *
 * Instead: this test pulls each pattern's example STRAIGHT OUT of the doc's
 * own fenced code block (by heading, via {@link extractFencedBlock}) — no
 * second copy of the snippet lives in this file — and runs it through
 * `findSubsetViolation` for real. A heading that's renamed or removed fails
 * loudly (`heading not found`); a snippet whose real verdict no longer
 * matches what the doc claims for it fails just as loudly. That is the
 * concrete failure mode from the day this issue was filed, closed for good.
 *
 * Scope: only patterns `findSubsetViolation` itself decides (EVL001/EVL003 —
 * see subset.ts's module doc for why those are the two it owns). Left out,
 * deliberately:
 *   - "Control flow around resources" (EVL002) and the `let`/`var`, `class`,
 *     `require()`, top-level `await`, decorator bullets under "Other
 *     unsupported patterns" — these are rejected at `foldModule`'s top-level
 *     statement scan, before any expression ever reaches
 *     `findSubsetViolation`. Not this module's concern, and not real,
 *     parseable TypeScript in the doc's own illustrative snippet (a bare
 *     `export` inside an `if` block isn't valid syntax to begin with).
 *   - "Import and re-export" / "Cross-file resource references" / "Typed
 *     property-kind constructors" are exercised below, but only prove the
 *     trivial case: `findSubsetViolation` treats every identifier as
 *     shape-valid regardless of whether it resolves locally, across a
 *     module boundary, or not at all (subset.ts's module doc, point 1) — a
 *     documented, intentional asymmetry, not something this guard can
 *     usefully narrow further without a binding resolver of its own.
 */

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const docPath = join(repoRoot, "docs", "src", "content", "docs", "concepts", "typescript-as-data.mdx");
const doc = readFileSync(docPath, "utf-8");

/** Pull the first ```typescript fenced block following `### {heading}`. */
function extractFencedBlock(heading: string): string {
  const headingMarker = `### ${heading}`;
  const headingIdx = doc.indexOf(headingMarker);
  if (headingIdx === -1) {
    throw new Error(
      `subset-doc-parity: heading "${headingMarker}" not found in ${docPath} — was it renamed or removed? Update this test to match.`,
    );
  }
  const fenceStart = doc.indexOf("```typescript", headingIdx);
  if (fenceStart === -1) {
    throw new Error(`subset-doc-parity: no \`\`\`typescript block found after "${headingMarker}"`);
  }
  const codeStart = doc.indexOf("\n", fenceStart) + 1;
  const fenceEnd = doc.indexOf("```", codeStart);
  if (fenceEnd === -1) {
    throw new Error(`subset-doc-parity: unterminated code fence after "${headingMarker}"`);
  }
  return doc.slice(codeStart, fenceEnd);
}

/** Parse `source` and return its top-level `const` bindings, keyed by name. */
function parseConsts(source: string): Map<string, ts.Expression> {
  const sourceFile = ts.createSourceFile("doc-example.ts", source, ts.ScriptTarget.Latest, /* setParentNodes */ true);
  return collectConsts(sourceFile);
}

/** The object-literal argument of `const <name> = new Type({...})`. */
function resourceArg(consts: Map<string, ts.Expression>, name: string): ts.Expression {
  const init = consts.get(name);
  if (!init || !ts.isNewExpression(init) || !init.arguments?.[0]) {
    throw new Error(`subset-doc-parity: "${name}" did not parse as a resource declaration with an object-literal arg`);
  }
  return init.arguments[0];
}

describe("subset-doc-parity — supported patterns in typescript-as-data.mdx classify as fold-clean", () => {
  test("Resource declarations", () => {
    const consts = parseConsts(extractFencedBlock("Resource declarations"));
    expect(findSubsetViolation(resourceArg(consts, "store"))).toBeUndefined();
  });

  test("Literal values", () => {
    const consts = parseConsts(extractFencedBlock("Literal values"));
    expect(findSubsetViolation(resourceArg(consts, "service"))).toBeUndefined();
  });

  test("Const variable references", () => {
    const consts = parseConsts(extractFencedBlock("Const variable references"));
    expect(findSubsetViolation(resourceArg(consts, "store"))).toBeUndefined();
  });

  test("Spread from const sources", () => {
    const consts = parseConsts(extractFencedBlock("Spread from const sources"));
    expect(findSubsetViolation(resourceArg(consts, "service"))).toBeUndefined();
  });

  test("Import and re-export", () => {
    // Trivial by construction — see this file's module doc.
    const consts = parseConsts(extractFencedBlock("Import and re-export"));
    expect(findSubsetViolation(resourceArg(consts, "store"))).toBeUndefined();
  });

  test("Cross-file resource references", () => {
    // Trivial by construction — see this file's module doc.
    const consts = parseConsts(extractFencedBlock("Cross-file resource references"));
    expect(findSubsetViolation(resourceArg(consts, "service"))).toBeUndefined();
  });

  test("Intrinsic tagged templates", () => {
    // subset.ts treats any tagged template's TAG as shape-valid regardless
    // of lexicon registration (that check is fold()'s job, not subset.ts's —
    // see subset.ts's module doc, point 2) — only the interpolated values
    // are classified, and this example's interpolation is a plain property
    // access chain.
    const consts = parseConsts(extractFencedBlock("Intrinsic tagged templates"));
    expect(findSubsetViolation(resourceArg(consts, "store"))).toBeUndefined();
  });

  test("Typed property-kind constructors", () => {
    const consts = parseConsts(extractFencedBlock("Typed property-kind constructors"));
    expect(findSubsetViolation(resourceArg(consts, "config"))).toBeUndefined();
    expect(findSubsetViolation(resourceArg(consts, "access"))).toBeUndefined();
  });

  test("Registered authoring helpers", () => {
    // chant #1082 — not a `new Type({...})` declaration, so classify the
    // exported component object literal directly. `findSubsetViolation`
    // checks the helper NAME only (subset.ts module doc, point 2b); the
    // doc's own snippet imports them from chant, which is what the bridge
    // additionally verifies at fold time.
    const consts = parseConsts(extractFencedBlock("Registered authoring helpers"));
    const web = consts.get("web");
    if (!web) throw new Error(`subset-doc-parity: "web" did not parse as a const declaration`);
    expect(findSubsetViolation(web)).toBeUndefined();
  });

  test("Nullish coalescing for defaults", () => {
    // Not a standalone statement in the doc (a single object-literal
    // property, deliberately shown as a fragment) — wrapped in an object
    // literal to parse, which also happens to be exactly the shape
    // `findSubsetViolation` classifies a resource prop through.
    const fragment = extractFencedBlock("Nullish coalescing for defaults").trim();
    const consts = parseConsts(`const _wrapped = { ${fragment} };`);
    const wrapped = consts.get("_wrapped");
    if (!wrapped) throw new Error("subset-doc-parity: nullish-coalescing fragment failed to parse");
    expect(findSubsetViolation(wrapped)).toBeUndefined();
  });
});

describe("subset-doc-parity — unsupported patterns in typescript-as-data.mdx classify as rejected", () => {
  test("Function calls as values", () => {
    const consts = parseConsts(extractFencedBlock("Function calls as values"));
    expect(findSubsetViolation(resourceArg(consts, "store"))).toBeDefined();
  });

  test("Dynamic property access", () => {
    // A bare `const`, not a resource declaration — check the initializer
    // directly rather than through `resourceArg`.
    const consts = parseConsts(extractFencedBlock("Dynamic property access"));
    const init = consts.get("name");
    if (!init) throw new Error(`subset-doc-parity: "name" did not parse as a const declaration`);
    expect(findSubsetViolation(init)).toBeDefined();
  });

  test("Spread from dynamic sources", () => {
    // Documented as EVL004 (a stricter, value-level narrowing rule subset.ts
    // doesn't model — see subset.ts's module doc, item 3) but this
    // particular example — spreading a CALL's result — is also rejected by
    // subset.ts's shape classifier on its own terms: a call expression
    // nested inside a spread is still a call expression. Asserting only
    // "rejected", not a specific rule id, since attributing a rule id here
    // is EVL004's job, not subset.ts's.
    const consts = parseConsts(extractFencedBlock("Spread from dynamic sources"));
    expect(findSubsetViolation(resourceArg(consts, "store"))).toBeDefined();
  });
});
