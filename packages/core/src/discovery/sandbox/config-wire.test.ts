import { describe, test, expect } from "vitest";
import { scanConfigWireSafety, formatConfigWireOffenders } from "./config-wire";

/**
 * chant #1113 — the contract for what a `chant.config.ts` may hold if it is to
 * be evaluated inside the `--sandbox` boundary. Only JSON crosses a process
 * boundary, and `JSON.stringify` is lossy without complaining, so this scan is
 * what turns "silently dropped" into "named and refused".
 */
describe("scanConfigWireSafety", () => {
  test("a real ChantConfig has nothing that cannot cross", () => {
    expect(
      scanConfigWireSafety({
        lexicons: ["aws", "k8s"],
        environments: ["staging", "prod"],
        sourceDir: "src",
        stacks: [{ name: "net", src: "src/net" }],
        ownership: { stack: "storefront", env: "prod", enabled: true },
        build: { fold: true, sandbox: true },
        buildParams: { tier: { type: "string", default: "light", enum: ["light", "prod"] } },
        lint: { rules: { COR001: "error", COR002: ["warning", { max: 3 }] }, policies: ["policies/org.ts"] },
        vulnPolicy: { failSeverity: "critical", license: { allow: ["MIT"], deny: [] } },
        // A lexicon's passthrough extension (the temporal lexicon's shape) —
        // still pure data.
        temporal: { profiles: { local: { address: "localhost:7233", tls: false } }, defaultProfile: "local" },
      }),
    ).toEqual([]);
  });

  test("null, empty objects and empty arrays are data", () => {
    expect(scanConfigWireSafety({ a: null, b: {}, c: [], d: 0, e: false, f: "" })).toEqual([]);
  });

  test.each([
    ["a function", { hooks: { before: () => 1 } }, "hooks.before", "a function"],
    ["a Date", { meta: { at: new Date(0) } }, "meta.at", "a Date"],
    ["a RegExp", { match: /x/ }, "match", "a RegExp"],
    ["a Map", { m: new Map() }, "m", "a Map"],
    ["a Set", { s: new Set() }, "s", "a Set"],
    ["a bigint", { n: 1n }, "n", "a bigint"],
    ["NaN", { n: Number.NaN }, "n", "NaN"],
    ["Infinity", { n: Number.POSITIVE_INFINITY }, "n", "a non-finite number"],
    ["a symbol", { s: Symbol("x") }, "s", "a symbol"],
  ])("%s is reported with its key path", (_label, config, path, found) => {
    expect(scanConfigWireSafety(config)).toEqual([{ path, found }]);
  });

  test("array positions are reported with an index", () => {
    expect(scanConfigWireSafety({ stacks: [{ name: "a", src: "s" }, { name: "b", src: () => "s" }] })).toEqual([
      { path: "stacks[1].src", found: "a function" },
    ]);
  });

  test("a class instance is reported by its constructor name", () => {
    class Policy {
      value = 1;
    }
    expect(scanConfigWireSafety({ p: new Policy() })).toEqual([{ path: "p", found: "a Policy instance" }]);
  });

  test("a circular reference is reported, not walked forever", () => {
    const a: Record<string, unknown> = { name: "a" };
    a.self = a;
    expect(scanConfigWireSafety({ a })).toEqual([{ path: "a.self", found: "a circular reference" }]);
  });

  test("every offender is reported, not just the first", () => {
    expect(scanConfigWireSafety({ a: () => 1, b: { c: new Date(0) } })).toEqual([
      { path: "a", found: "a function" },
      { path: "b.c", found: "a Date" },
    ]);
  });

  /**
   * The one accepted lossy case, and its boundary: `{ x: undefined }` reads
   * identically to `{}` for every consumer of `ChantConfig` (every field is
   * optional), while an `undefined` in an ARRAY becomes `null` and changes the
   * element — so only the latter is reported. See the module doc.
   */
  test("an undefined property is dropped like an omitted key; an undefined array slot is not", () => {
    expect(scanConfigWireSafety({ sourceDir: undefined, lexicons: ["aws"] })).toEqual([]);
    expect(scanConfigWireSafety({ lexicons: ["aws", undefined] })).toEqual([
      { path: "lexicons[1]", found: "undefined" },
    ]);
  });

  test("a module namespace (a config of top-level named exports) is walked, not rejected wholesale", () => {
    const namespace = Object.create(null) as Record<string, unknown>;
    namespace.lexicons = ["aws"];
    expect(scanConfigWireSafety(namespace)).toEqual([]);
  });

  test("a non-object config says nothing about serializability — normalizeConfig rejects it", () => {
    expect(scanConfigWireSafety("nope")).toEqual([]);
    expect(scanConfigWireSafety(null)).toEqual([]);
  });
});

describe("formatConfigWireOffenders", () => {
  test("names the config file, every offending key, and what to do", () => {
    const message = formatConfigWireOffenders("/p/chant.config.ts", [
      { path: "hooks.before", found: "a function" },
      { path: "meta.at", found: "a Date" },
    ]);
    expect(message).toContain("/p/chant.config.ts");
    expect(message).toContain("hooks.before: a function");
    expect(message).toContain("meta.at: a Date");
    expect(message).toContain("drop --sandbox");
  });
});
