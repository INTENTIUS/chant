import { describe, test, expect } from "vitest";
import { isDeclarable, DECLARABLE_MARKER } from "./declarable";
import { INTRINSIC_MARKER } from "./intrinsic";
import { STACK_OUTPUT_MARKER } from "./stack-output";
import { COMPOSITE_MARKER } from "./composite";

/**
 * chant#2444 — `isDeclarable` accepts an entity a HOST built.
 *
 * `F-Host-Interface` item 1 says an entity carries a non-enumerable declarable
 * marker, and a host supplies its own. Testing identity against chant's symbol
 * alone refused those for not being chant's rather than for being malformed —
 * which is what chant#2442 hit inside composite member validation, and what
 * would otherwise keep biting in the entity tallies and the revival
 * pass-through, where it fails silently rather than loudly.
 *
 * The interesting half of this test file is the second describe block. The
 * reference implementation reads the same rule as "any own symbol or
 * non-enumerable own property", which is right for a domain with one marker and
 * wrong for chant, which has seven. Those cases pin the narrowing.
 */
function marked(symbol: symbol, value: unknown = true): object {
  const o = {};
  Object.defineProperty(o, symbol, { value, enumerable: false });
  return o;
}

describe("isDeclarable accepts a host's marker (chant#2444)", () => {
  test("chant's own marker, which is every entity a chant build makes", () => {
    expect(isDeclarable(marked(DECLARABLE_MARKER))).toBe(true);
  });

  test("the specification host's marker", () => {
    // The exact symbol `@tsad/shapes` uses. This is the case chant#2442 hit.
    expect(isDeclarable(marked(Symbol.for("tsad.conformance.declarable")))).toBe(true);
  });

  test("any implementation's, as long as the marker says declarable", () => {
    expect(isDeclarable(marked(Symbol.for("some.other.tool.declarable")))).toBe(true);
  });

  test("a plain object is not one", () => {
    expect(isDeclarable({})).toBe(false);
    expect(isDeclarable({ entityType: "Bucket", props: {} })).toBe(false);
    expect(isDeclarable(null)).toBe(false);
    expect(isDeclarable("Bucket")).toBe(false);
  });
});

describe("the narrowing, and why the reference's reading is unsafe here", () => {
  test("chant's OTHER markers are not declarable markers", () => {
    // The measurement that decided the implementation. Under "any own symbol",
    // every one of these classifies as an entity and enters the tallies — a
    // worse bug than the one chant#2444 fixes.
    expect(isDeclarable(marked(INTRINSIC_MARKER))).toBe(false);
    expect(isDeclarable(marked(STACK_OUTPUT_MARKER))).toBe(false);
    expect(isDeclarable(marked(COMPOSITE_MARKER))).toBe(false);
  });

  test("a non-enumerable own NAME is not a marker either", () => {
    // A real chant entity's non-enumerable own names are `lexicon`,
    // `entityType`, `kind`, `props`, `attributes` and `Ref`. Reading "any
    // non-enumerable own property" as the marker is close to "any chant object".
    const o = {};
    Object.defineProperty(o, "props", { value: {}, enumerable: false });
    Object.defineProperty(o, "entityType", { value: "Bucket", enumerable: false });
    expect(isDeclarable(o)).toBe(false);
  });

  test("an ENUMERABLE declarable symbol is refused", () => {
    // F-Host-Interface item 1 says non-enumerable, and it matters: an
    // enumerable marker travels through a spread and would reach an artifact.
    const o = {};
    Object.defineProperty(o, Symbol.for("x.declarable"), { value: true, enumerable: true });
    expect(isDeclarable(o)).toBe(false);
  });

  test("a declarable symbol whose value is not true is refused", () => {
    expect(isDeclarable(marked(Symbol.for("x.declarable"), false))).toBe(false);
    expect(isDeclarable(marked(Symbol.for("x.declarable"), "yes"))).toBe(false);
  });

  test("a symbol that merely contains the word is refused", () => {
    // Suffix, not substring: `declarable.thing` is not a declarable marker.
    expect(isDeclarable(marked(Symbol.for("x.declarable.thing")))).toBe(false);
    expect(isDeclarable(marked(Symbol.for("notdeclarable")))).toBe(false);
  });
});
