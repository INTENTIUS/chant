import { describe, test, expect } from "vitest";
import {
  DEFAULT_MACRO_NAMES,
  bind,
  defCedarMacro,
  defTemporalMacro,
  defaultMacroLibrary,
  macroCondition,
  macroTerm,
  macroWindow,
  renderMacroDefinition,
  renderMacroLibrary,
} from "./macros";
import { and, count, formerly, renderCondition, tp, typedBinder } from "./temporal";

describe("def-macro authoring", () => {
  test("a temporal macro renders as upstream's def_decl", () => {
    const def = defTemporalMacro("once", ["?w", "?s"], formerly(macroWindow("?w"), macroCondition("?s")));
    expect(renderMacroDefinition(def)).toBe(
      "def temporal once(?w, ?s) {\n    formerly within ?w ?s\n};",
    );
  });

  test("a temporal macro body may be a bare aggregation value", () => {
    const def = defTemporalMacro(
      "count_within",
      ["?w", "?s"],
      count(
        [typedBinder("$t", "Timepoint")],
        formerly(macroWindow("?w"), and(macroCondition("?s"), tp("$t"))),
      ),
    );
    expect(renderMacroDefinition(def)).toContain("count for ($t: Timepoint). where formerly within ?w (?s && tp($t))");
  });

  test("a cedar macro keeps its body as Cedar expression text", () => {
    const def = defCedarMacro("is_small", ["?n"], "?n < 100");
    expect(renderMacroDefinition(def)).toBe("def cedar is_small(?n) {\n    ?n < 100\n};");
  });

  test("a comment is emitted above the definition", () => {
    const def = defCedarMacro("is_small", ["?n"], "?n < 100", "Under a hundred.\nNothing more.");
    expect(renderMacroDefinition(def).split("\n").slice(0, 2)).toEqual([
      "// Under a hundred.",
      "// Nothing more.",
    ]);
  });

  test("a parameter without the ? sigil is refused, and the message says which to write", () => {
    expect(() => defCedarMacro("is_small", ["n"], "n < 100")).toThrow(/carries the "\?" sigil.*"\?n"/s);
  });

  test("a macro name that is not an identifier is refused", () => {
    expect(() => defCedarMacro("is small", [], "true")).toThrow(/must be an identifier/);
  });
});

describe("the two sigils", () => {
  test("?p splices a call-site value; $t is a macro-introduced fresh binder", () => {
    expect(renderCondition(macroCondition("?s"))).toBe("?s");
    expect(macroTerm("$t").text).toBe("$t");
    expect(macroTerm("?a").text).toBe("?a");
  });

  test("a $ sigil is not a window parameter — the expander resolves only ?p there", () => {
    expect(() => macroWindow("$w")).toThrow(/carries the "\?" sigil/);
  });

  test("a bare identifier is not a sigil", () => {
    expect(() => macroCondition("s")).toThrow(/carries the "\?" sigil/);
    expect(() => macroTerm("a")).toThrow(/carries a "\?" or "\$" sigil/);
  });
});

describe("the default library", () => {
  test("names exactly what upstream's default_macros.dw ships", () => {
    expect([...DEFAULT_MACRO_NAMES]).toEqual([
      "count_within",
      "sum_within",
      "count_distinct_within",
      "bind",
    ]);
    expect(defaultMacroLibrary().map((d) => d.name)).toEqual([...DEFAULT_MACRO_NAMES]);
  });

  test("every definition is a temporal macro whose params all carry the sigil", () => {
    for (const def of defaultMacroLibrary()) {
      expect(def.kind).toBe("temporal");
      for (const param of def.params) expect(param.startsWith("?")).toBe(true);
    }
  });

  test("bind() is a call, so a policy using it depends on the callee's --macros", () => {
    const node = bind("n", macroCondition("?A"), macroCondition("?B"));
    expect(node.op).toBe("call");
    expect(renderCondition(node)).toBe("bind(n, ?A, ?B)");
  });

  test("the library renders as a file a --macros flag can point at", () => {
    const text = renderMacroLibrary(defaultMacroLibrary());
    expect(text.endsWith("};\n")).toBe(true);
    expect(text.split("\n\n")).toHaveLength(4);
  });
});
