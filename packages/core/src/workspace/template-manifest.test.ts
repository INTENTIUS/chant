import { describe, expect, test } from "vitest";
import { TEMPLATE_MANIFEST, carryParameters, parseParamArgs, readManifest, resolveParameters, substituteParameters } from "./template-manifest";

function tree(files: Record<string, string>): Map<string, Buffer> {
  return new Map(Object.entries(files).map(([k, v]) => [k, Buffer.from(v)]));
}
const manifest = (m: unknown): Map<string, Buffer> => tree({ [TEMPLATE_MANIFEST]: JSON.stringify(m) });

describe("chant.template.json", () => {
  test("a template without one declares no parameters", () => {
    expect(readManifest(tree({ "a.ts": "x" }))).toBeNull();
    expect(resolveParameters(null, {})).toEqual({});
    expect(() => resolveParameters(null, { name: "x" })).toThrow("unknown parameter name (the template declares none)");
  });

  test("refuses bad JSON, unknown keys, bad names, bad paths and a default that fails its pattern", () => {
    expect(() => readManifest(tree({ [TEMPLATE_MANIFEST]: "{" }))).toThrow(/not valid JSON/);
    expect(() => readManifest(manifest({ parameters: {}, files: [], extra: 1 }))).toThrow(/invalid chant.template.json/);
    expect(() => readManifest(manifest({ parameters: { "a-b": { type: "string" } }, files: [] }))).toThrow(/parameter name/);
    expect(() => readManifest(manifest({ parameters: { n: { type: "number" } }, files: [] }))).toThrow(/parameters.n.type/);
    expect(() => readManifest(manifest({ parameters: {}, files: ["../x"] }))).toThrow(/not a normalised path/);
    expect(() => readManifest(manifest({ parameters: {}, files: [".chant/migrations/m.json"] }))).toThrow(/not a normalised path/);
    expect(() => readManifest(manifest({ parameters: { n: { type: "string", default: "a b", pattern: "^\\S+$" } }, files: [] }))).toThrow(
      /its default "a b" does not match/,
    );
  });

  test("resolves given values and defaults; refuses undeclared names, listing the declared ones", () => {
    const m = readManifest(
      manifest({
        parameters: {
          name: { type: "string", default: "Starter", pattern: "^[A-Za-z ]+$" },
          owner: { type: "string" },
          url: { type: "string", default: "http://localhost", hostBound: true },
        },
        files: [],
      }),
    );
    expect(resolveParameters(m, { owner: "me" })).toEqual({ name: "Starter", owner: "me", url: "http://localhost" });
    expect(resolveParameters(m, { owner: "me", name: "Untitled app" }).name).toBe("Untitled app");
    expect(() => resolveParameters(m, { owner: "me", titel: "x" })).toThrow("unknown parameter titel (declared: name, owner, url)");
    expect(() => resolveParameters(m, {})).toThrow("parameter owner has no default; pass --param owner=<value>");
    expect(() => resolveParameters(m, { owner: "me", name: 'x"; rm' })).toThrow(/does not match/);
  });

  test("substitutes {{chant:<name>}} in listed files only, and drops the manifest", () => {
    const m = readManifest(manifest({ parameters: { name: { type: "string" } }, files: ["a.ts"] }));
    const files = tree({
      [TEMPLATE_MANIFEST]: "{}",
      "a.ts": 'const t = "{{chant:name}}"; const u = `${t}`; const g = "${{ github.sha }}"; const h = "{{name}}";\n',
      "b.ts": 'const t = "{{chant:name}}";\n',
    });
    const out = substituteParameters(files, m, { name: "Acme" });
    expect(out.has(TEMPLATE_MANIFEST)).toBe(false);
    expect(out.get("a.ts")!.toString()).toBe('const t = "Acme"; const u = `${t}`; const g = "${{ github.sha }}"; const h = "{{name}}";\n');
    expect(out.get("b.ts")!.toString()).toBe('const t = "{{chant:name}}";\n');
    // Values are inserted once: a value that looks like a placeholder stays as written.
    expect(substituteParameters(files, m, { name: "{{chant:name}}" }).get("a.ts")!.toString()).toContain('"{{chant:name}}"');
  });

  test("refuses a listed file that is missing and a placeholder with no declaration", () => {
    const m = readManifest(manifest({ parameters: { name: { type: "string" } }, files: ["a.ts"] }));
    expect(() => substituteParameters(tree({}), m, { name: "x" })).toThrow("chant.template.json lists a.ts, which is not in the template");
    expect(() => substituteParameters(tree({ "a.ts": "{{chant:owner}}" }), m, { name: "x" })).toThrow(/declares no parameter owner/);
  });

  test("--param arguments split at the first =, and a repeated name is refused", () => {
    expect(parseParamArgs(["name=Untitled app", "expr=a=b", "empty="])).toEqual({ name: "Untitled app", expr: "a=b", empty: "" });
    expect(() => parseParamArgs(["name"])).toThrow(/expected <name>=<value>/);
    expect(() => parseParamArgs(["=x"])).toThrow(/expected <name>=<value>/);
    expect(() => parseParamArgs(["a=1", "a=2"])).toThrow(/given twice/);
  });

  test("an upgrade carries recorded values, adds defaults and drops undeclared names", () => {
    const m = readManifest(manifest({ parameters: { name: { type: "string" }, owner: { type: "string", default: "platform" } }, files: [] }));
    expect(carryParameters(m, { name: "Acme", gone: "x" })).toEqual({ name: "Acme", owner: "platform" });
    expect(carryParameters(null, { name: "Acme" })).toEqual({});
  });
});
