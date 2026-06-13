import { describe, expect, test } from "vitest";
import { setProvenance, getProvenance } from "./provenance";
import { Composite, expandComposite } from "./composite";
import { collectEntities } from "./discovery/collect";
import { DECLARABLE_MARKER, type Declarable } from "./declarable";

const decl = (entityType: string): Declarable =>
  ({ [DECLARABLE_MARKER]: true, lexicon: "test", entityType, kind: "resource", props: {} }) as unknown as Declarable;

const Pair = Composite<{ n: string }>((props) => ({
  first: decl(`Test::First:${props.n}`),
  second: decl(`Test::Second:${props.n}`),
}), "Pair");

describe("provenance side channel", () => {
  test("set then get returns the stamped fields", () => {
    const e = decl("Test::Thing");
    setProvenance(e, { sourceFile: "/proj/src/a.ts" });
    setProvenance(e, { composite: "MyComposite" });
    expect(getProvenance(e)).toEqual({ sourceFile: "/proj/src/a.ts", composite: "MyComposite" });
  });

  test("first writer wins (??= merge keeps the most specific)", () => {
    const e = decl("Test::Thing");
    setProvenance(e, { composite: "Inner" });
    setProvenance(e, { composite: "Outer" });
    expect(getProvenance(e)?.composite).toBe("Inner");
  });

  test("provenance is non-enumerable — invisible to spreads and JSON", () => {
    const e = decl("Test::Thing");
    setProvenance(e, { sourceFile: "/x.ts" });
    expect(Object.keys(e)).not.toContain(Symbol.for("chant.provenance").toString());
    expect(JSON.stringify(e)).not.toContain("provenance");
  });

  test("getProvenance is undefined when nothing was stamped", () => {
    expect(getProvenance(decl("Test::Thing"))).toBeUndefined();
  });
});

describe("composite expansion stamps composite provenance", () => {
  test("expandComposite stamps each member with the composite name", () => {
    const expanded = expandComposite("p", Pair({ n: "x" }));
    for (const [, entity] of expanded) {
      expect(getProvenance(entity)?.composite).toBe("Pair");
    }
  });

  test("nested composites keep the innermost composite name", () => {
    // expandComposite recurses on CompositeInstance members at runtime; the
    // CompositeMembers type only models Declarable leaves, so cast the nested
    // composite to satisfy the factory's static type.
    const Wrapper = Composite<{ n: string }>((props) => ({
      inner: Pair({ n: props.n }) as unknown as Declarable,
    }), "Wrapper");
    const expanded = expandComposite("w", Wrapper({ n: "y" }));
    // Pair's members are the leaves; the inner (Pair) name must win over Wrapper.
    for (const [, entity] of expanded) {
      expect(getProvenance(entity)?.composite).toBe("Pair");
    }
  });
});

describe("collectEntities stamps the source file", () => {
  test("direct exports get their declaring file", () => {
    const a = decl("Test::A");
    const entities = collectEntities([{ file: "/proj/src/infra.ts", exports: { a } }]);
    expect(getProvenance(entities.get("a")!)?.sourceFile).toBe("/proj/src/infra.ts");
  });

  test("composite-expanded entities get both file and composite", () => {
    const entities = collectEntities([{ file: "/proj/src/pipe.ts", exports: { p: Pair({ n: "z" }) } }]);
    const member = entities.get("pFirst")!;
    const prov = getProvenance(member);
    expect(prov?.sourceFile).toBe("/proj/src/pipe.ts");
    expect(prov?.composite).toBe("Pair");
  });
});
