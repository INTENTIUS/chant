import { describe, expect, test } from "vitest";
import {
  EmbeddedImports,
  EmbeddedImportScope,
  embeddedDocument,
  exportedNames,
  isEmbeddedReference,
  renderEmbeddedReference,
  type EmbeddedContent,
  type EmbeddedContentImporter,
} from "./embedded";

const site = (over: Partial<EmbeddedContent> = {}): EmbeddedContent => ({
  host: "k8s",
  hostType: "K8s::Core::ConfigMap",
  location: 'ConfigMap agent data["config.yaml"]',
  directory: "agent",
  text: "kind: widget\nsize: 3\n",
  ...over,
});

/** Imports any `kind: widget` document as `widgets.ts`, passed through `render`. */
const widgets: EmbeddedContentImporter = {
  what: "a widget",
  matches: (c) => (c.document as { kind?: string } | undefined)?.kind === "widget",
  import: () => ({
    files: [{ path: "widgets.ts", content: "const w = 1;\n\nexport { w };\n" }],
    value: { bindings: [{ from: "widgets.ts", name: "w" }], shape: "list", through: { from: "@acme/widgets", name: "render" } },
    warnings: ["dropped the colour"],
  }),
};

describe("EmbeddedImports", () => {
  test("an importer that matches gets the content, with its document parsed from the text", () => {
    const seen: EmbeddedContent[] = [];
    const resolver = new EmbeddedImports([{ lexicon: "acme", importer: { ...widgets, import: (c) => (seen.push(c), widgets.import(c)) } }]);
    const ref = resolver.resolve(site());
    expect(seen[0].document).toEqual({ kind: "widget", size: 3 });
    expect(isEmbeddedReference(ref)).toBe(true);
    // Local modules are rebased under the content's directory; packages stay as they are.
    expect(ref!.$embedded).toEqual({
      lexicon: "acme",
      what: "a widget",
      location: 'ConfigMap agent data["config.yaml"]',
      value: { bindings: [{ from: "agent/widgets.ts", name: "w" }], shape: "list", through: { from: "@acme/widgets", name: "render" } },
    });
    expect(resolver.files).toEqual([{ path: "agent/widgets.ts", content: "const w = 1;\n\nexport { w };\n" }]);
    expect(resolver.warnings).toEqual(['ConfigMap agent data["config.yaml"]: dropped the colour']);
    expect(resolver.offered).toHaveLength(1);
  });

  test("two pieces of content wanting one directory get two", () => {
    const resolver = new EmbeddedImports([{ lexicon: "acme", importer: widgets }]);
    resolver.resolve(site({ directory: "Agent Config" }));
    resolver.resolve(site({ directory: "agent-config" }));
    expect(resolver.files.map((f) => f.path)).toEqual(["agent-config/widgets.ts", "agent-config-2/widgets.ts"]);
  });

  test("content nobody claims is kept, with a warning only when the host names its expected owner", () => {
    const resolver = new EmbeddedImports([{ lexicon: "acme", importer: widgets }]);
    expect(resolver.resolve(site({ text: "kind: gadget\n" }))).toBeUndefined();
    expect(resolver.warnings).toEqual([]);
    expect(resolver.resolve(site({ text: "kind: gadget\n", expectedOwner: { lexicon: "gadgets", what: "a gadget" } }))).toBeUndefined();
    expect(resolver.warnings).toHaveLength(1);
    expect(resolver.warnings[0]).toContain("looks like a gadget");
    expect(resolver.warnings[0]).toContain("@intentius/chant-lexicon-gadgets");
  });

  test("a quiet probe collects what is offered and warns about nothing", () => {
    const probe = new EmbeddedImports([], { quiet: true });
    expect(probe.resolve(site({ expectedOwner: { lexicon: "gadgets", what: "a gadget" } }))).toBeUndefined();
    expect(probe.offered).toHaveLength(1);
    expect(probe.warnings).toEqual([]);
  });

  test("a failing import keeps the content and says why; a throwing matcher is a non-match", () => {
    const resolver = new EmbeddedImports([
      { lexicon: "broken", importer: { what: "a widget", matches: () => { throw new Error("no"); }, import: widgets.import } },
      { lexicon: "acme", importer: { ...widgets, import: () => { throw new Error("bad size"); } } },
    ]);
    expect(resolver.resolve(site())).toBeUndefined();
    expect(resolver.files).toEqual([]);
    expect(resolver.warnings).toEqual([
      'ConfigMap agent data["config.yaml"] looks like a widget, but the acme import failed, so it is kept as written: bad size',
    ]);
  });

  test("when two lexicons match, the first imports it and the other is named", () => {
    const resolver = new EmbeddedImports([
      { lexicon: "acme", importer: widgets },
      { lexicon: "other", importer: widgets },
    ]);
    expect(resolver.resolve(site())!.$embedded.lexicon).toBe("acme");
    expect(resolver.warnings[0]).toContain("also importable by other");
  });
});

describe("renderEmbeddedReference", () => {
  const ref = (bindings: Array<{ from: string; name: string; member?: string }>, shape: "list" | "single", through?: { from: string; name: string }) => ({
    $embedded: { lexicon: "acme", what: "a widget", location: "here", value: { bindings, shape, ...(through ? { through } : {}) } },
  });

  test("imports each name once, relative to the module, and aliases a name already taken", () => {
    const scope = new EmbeddedImportScope("", ["otlp"]);
    const a = renderEmbeddedReference(
      ref([{ from: "agent/receivers.ts", name: "otlp" }, { from: "agent/pipelines.ts", name: "traces" }], "list", { from: "@acme/otel", name: "collectorYaml" }),
      scope,
    );
    const b = renderEmbeddedReference(ref([{ from: "gateway/receivers.ts", name: "otlp" }], "list"), scope);
    expect(a).toBe("collectorYaml([otlp2, traces])");
    expect(b).toBe("[otlp3]");
    expect(scope.lines()).toEqual([
      'import { collectorYaml } from "@acme/otel";',
      'import { traces } from "./agent/pipelines";',
      'import { otlp as otlp2 } from "./agent/receivers";',
      'import { otlp as otlp3 } from "./gateway/receivers";',
    ]);
  });

  test("a single binding, a member, and a module in a subdirectory", () => {
    const scope = new EmbeddedImportScope("infra");
    expect(renderEmbeddedReference(ref([{ from: "rules/slos.ts", name: "api", member: "rules" }], "single"), scope)).toBe("api.rules");
    expect(scope.lines()).toEqual(['import { api } from "../rules/slos";']);
  });

  test("a long list is broken one binding per line", () => {
    const names = Array.from({ length: 12 }, (_, i) => ({ from: "c/x.ts", name: `component${i}` }));
    const out = renderEmbeddedReference(ref(names, "list"), new EmbeddedImportScope(""), 4);
    expect(out.split("\n")).toHaveLength(14);
    expect(out.split("\n")[1]).toBe("      component0,");
    expect(out.endsWith("\n    ]")).toBe(true);
  });
});

describe("helpers", () => {
  test("embeddedDocument reads JSON or one YAML document", () => {
    expect(embeddedDocument('{"a": 1}')).toEqual({ a: 1 });
    expect(embeddedDocument("a: 1\n")).toEqual({ a: 1 });
    expect(embeddedDocument("a: 1\n---\nb: 2\n")).toBeUndefined();
  });

  test("exportedNames reads one-line and multi-line export lists", () => {
    expect(exportedNames("const a = 1;\n\nexport { a, b };\n")).toEqual(["a", "b"]);
    expect(exportedNames("export {\n  one,\n  two as three,\n};\n")).toEqual(["one", "three"]);
    expect(exportedNames("export const x = 1;\n")).toEqual([]);
  });

  test("isEmbeddedReference", () => {
    expect(isEmbeddedReference({ $embedded: { value: { bindings: [] } } })).toBe(true);
    expect(isEmbeddedReference({ $embedded: true })).toBe(false);
    expect(isEmbeddedReference("x")).toBe(false);
  });
});
