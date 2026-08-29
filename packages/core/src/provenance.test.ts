import { describe, expect, test } from "vitest";
import {
  describePathOrigin,
  getPathProvenance,
  getProvenance,
  originOfPath,
  setPathProvenance,
  setProvenance,
  type PathOrigin,
} from "./provenance";
import { Composite, expandComposite, propagate } from "./composite";
import { collectEntities } from "./discovery/collect";
import { DECLARABLE_MARKER, type Declarable } from "./declarable";

const decl = (entityType: string, props: Record<string, unknown> = {}): Declarable =>
  ({ [DECLARABLE_MARKER]: true, lexicon: "test", entityType, kind: "resource", props }) as unknown as Declarable;

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

describe("path provenance storage (#1443)", () => {
  test("first writer wins per path, independently of other paths", () => {
    const e = decl("Test::Thing");
    setPathProvenance(e, "spec.replicas", { kind: "build-param", params: ["tier"] });
    setPathProvenance(e, "spec.replicas", { kind: "authored" });
    setPathProvenance(e, "", { kind: "authored" });
    expect(getPathProvenance(e)).toEqual({
      "": { kind: "authored" },
      "spec.replicas": { kind: "build-param", params: ["tier"] },
    });
  });

  test("keys come back sorted, whatever order they were written in", () => {
    const e = decl("Test::Thing");
    setPathProvenance(e, "spec.z", { kind: "authored" });
    setPathProvenance(e, "metadata.a", { kind: "authored" });
    setPathProvenance(e, "", { kind: "authored" });
    expect(Object.keys(getPathProvenance(e)!)).toEqual(["", "metadata.a", "spec.z"]);
  });

  test("path origins stay off the serialized entity", () => {
    const e = decl("Test::Thing");
    setPathProvenance(e, "spec.replicas", { kind: "authored" });
    expect(JSON.stringify(e)).not.toContain("replicas");
  });

  test("nothing recorded reads as undefined, not an empty record", () => {
    expect(getPathProvenance(decl("Test::Thing"))).toBeUndefined();
    expect(originOfPath(undefined, "spec.replicas")).toBeUndefined();
  });
});

describe("originOfPath resolution", () => {
  const paths: Record<string, PathOrigin> = {
    "": { kind: "authored" },
    spec: { kind: "composite", composite: "WebService", instance: "web" },
    "spec.template.spec.containers": { kind: "build-param", params: ["image", "tier"] },
  };

  test("the longest matching prefix wins", () => {
    expect(originOfPath(paths, "spec.template.spec.containers")).toEqual(paths["spec.template.spec.containers"]);
    expect(originOfPath(paths, "spec.replicas")).toEqual(paths.spec);
    expect(originOfPath(paths, "metadata.name")).toEqual(paths[""]);
  });

  test("a keyed list element inherits the origin recorded for the list (#1441 grammar)", () => {
    expect(originOfPath(paths, "spec.template.spec.containers[#app].image")).toEqual(
      paths["spec.template.spec.containers"],
    );
    expect(originOfPath(paths, "spec.template.spec.containers[0].image")).toEqual(
      paths["spec.template.spec.containers"],
    );
  });

  test("prefixes only match on a segment boundary", () => {
    // `spec` must not claim `specialCase`, and a deeper recorded key must not
    // claim a shallower query.
    expect(originOfPath(paths, "specialCase")).toEqual(paths[""]);
    expect(originOfPath({ "spec.containers.image": { kind: "authored" } }, "spec.containers")).toBeUndefined();
  });
});

describe("describePathOrigin", () => {
  test("renders each kind", () => {
    expect(describePathOrigin({ kind: "authored" })).toBe("authored");
    expect(describePathOrigin({ kind: "composite", composite: "WebService", instance: "web" })).toBe(
      "composite WebService (web)",
    );
    expect(describePathOrigin({ kind: "build-param", params: ["region", "tier"] })).toBe("param region, tier");
  });
});

describe("composite expansion records path origins (#1443)", () => {
  test("each member's whole-entity origin names the composite and the instance", () => {
    const expanded = expandComposite("web", Pair({ n: "x" }));
    for (const [, entity] of expanded) {
      expect(originOfPath(getPathProvenance(entity), "anything.at.all")).toEqual({
        kind: "composite",
        composite: "Pair",
        instance: "web",
      });
    }
  });

  test("a nested member keeps the innermost composite but the outer instance", () => {
    const Wrapper = Composite<{ n: string }>((props) => ({
      inner: Pair({ n: props.n }) as unknown as Declarable,
    }), "Wrapper");
    const expanded = expandComposite("stack", Wrapper({ n: "y" }));
    for (const [, entity] of expanded) {
      expect(getPathProvenance(entity)?.[""]).toEqual({
        kind: "composite",
        composite: "Pair",
        instance: "stack",
      });
    }
  });

  test("a propagated key the member never set is attributed to the instance", () => {
    const Tagged = Composite<{ n: string }>(() => ({
      only: decl("Test::Only", { name: "fixed" }),
    }), "Tagged");
    const expanded = expandComposite("env", propagate(Tagged({ n: "x" }), { tags: [{ key: "env", value: "prod" }] }));
    const entity = expanded.get("envOnly")!;
    expect(getPathProvenance(entity)?.tags).toEqual({
      kind: "composite",
      composite: "Tagged",
      instance: "env",
    });
  });

  test("a key both the member and the propagation wrote is left to the whole-entity origin", () => {
    const Tagged = Composite<{ n: string }>(() => ({
      only: decl("Test::Only", { tags: [{ key: "own", value: "1" }] }),
    }), "Tagged");
    const expanded = expandComposite("env", propagate(Tagged({ n: "x" }), { tags: [{ key: "env", value: "prod" }] }));
    const paths = getPathProvenance(expanded.get("envOnly")!);
    expect(paths?.tags).toBeUndefined();
    expect(paths?.[""]).toBeDefined();
  });
});

describe("collectEntities records the authored origin", () => {
  test("a directly exported declarable is authored at the root", () => {
    const a = decl("Test::A");
    const entities = collectEntities([{ file: "/proj/src/infra.ts", exports: { a } }]);
    expect(getPathProvenance(entities.get("a")!)?.[""]).toEqual({ kind: "authored" });
  });

  test("a composite member is not relabelled authored", () => {
    const entities = collectEntities([{ file: "/proj/src/pipe.ts", exports: { p: Pair({ n: "z" }) } }]);
    expect(getPathProvenance(entities.get("pFirst")!)?.[""]).toEqual({
      kind: "composite",
      composite: "Pair",
      instance: "p",
    });
  });
});
