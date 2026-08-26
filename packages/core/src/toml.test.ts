import { describe, test, expect } from "vitest";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { parseTOML, TomlParseError } from "./toml";

describe("parseTOML — spike-grade coverage of real-world TOML (#446)", () => {
  test("scalars: strings, integers, floats, booleans", () => {
    const doc = parseTOML(`
      name = "my-worker"
      count = 42
      ratio = 3.14
      negative = -7
      enabled = true
      disabled = false
      literal = 'raw \\n text'
    `);
    expect(doc.name).toBe("my-worker");
    expect(doc.count).toBe(42);
    expect(doc.ratio).toBeCloseTo(3.14);
    expect(doc.negative).toBe(-7);
    expect(doc.enabled).toBe(true);
    expect(doc.disabled).toBe(false);
    expect(doc.literal).toBe("raw \\n text");
  });

  test("double-quoted string escapes", () => {
    const doc = parseTOML(`s = "line1\\nline2\\ttabbed \\"quoted\\""`);
    expect(doc.s).toBe('line1\nline2\ttabbed "quoted"');
  });

  test("comments are ignored", () => {
    const doc = parseTOML(`
      # a top comment
      a = 1 # trailing comment
      # another
      b = 2
    `);
    expect(doc).toEqual({ a: 1, b: 2 });
  });

  test("arrays: single-line and multi-line", () => {
    const doc = parseTOML(`
      inline = [1, 2, 3]
      multi = [
        "a",
        "b",
        "c",
      ]
    `);
    expect(doc.inline).toEqual([1, 2, 3]);
    expect(doc.multi).toEqual(["a", "b", "c"]);
  });

  test("inline tables", () => {
    const doc = parseTOML(`route = { pattern = "api.example.com/*", zone_name = "example.com" }`);
    expect(doc.route).toEqual({ pattern: "api.example.com/*", zone_name: "example.com" });
  });

  test("array of inline tables", () => {
    const doc = parseTOML(`routes = [{ pattern = "a/*", zone_name = "a.com" }, { pattern = "b/*", zone_name = "b.com" }]`);
    expect(doc.routes).toEqual([
      { pattern: "a/*", zone_name: "a.com" },
      { pattern: "b/*", zone_name: "b.com" },
    ]);
  });

  test("standard tables, nested dotted tables", () => {
    const doc = parseTOML(`
      [observability]
      enabled = false

      [env.production]
      workers_dev = false

      [env.production.vars]
      ENVIRONMENT = "production"
    `);
    expect(doc.observability).toEqual({ enabled: false });
    expect(doc.env).toEqual({ production: { workers_dev: false, vars: { ENVIRONMENT: "production" } } });
  });

  test("arrays of tables accumulate entries", () => {
    const doc = parseTOML(`
      [[kv_namespaces]]
      binding = "MY_KV"
      id = "abc123"

      [[kv_namespaces]]
      binding = "OTHER_KV"
      id = "def456"
    `);
    expect(doc.kv_namespaces).toEqual([
      { binding: "MY_KV", id: "abc123" },
      { binding: "OTHER_KV", id: "def456" },
    ]);
  });

  test("dotted keys create nested tables inline", () => {
    const doc = parseTOML(`a.b.c = 1\na.b.d = 2`);
    expect(doc.a).toEqual({ b: { c: 1, d: 2 } });
  });

  test("a full representative wrangler.toml", () => {
    const src = `
      name = "my-worker"
      main = "src/index.ts"
      compatibility_date = "2024-01-01"
      workers_dev = true

      [observability]
      enabled = false

      [vars]
      ENVIRONMENT = "production"

      [[kv_namespaces]]
      binding = "MY_KV"
      id = "abc123"

      [[r2_buckets]]
      binding = "MY_BUCKET"
      bucket_name = "my-bucket"

      [triggers]
      crons = ["0 0 * * *"]

      [[routes]]
      pattern = "example.com/*"
      zone_name = "example.com"

      [env.production]
      workers_dev = false

      [env.production.vars]
      ENVIRONMENT = "production"
    `;
    const doc = parseTOML(src);
    expect(doc.name).toBe("my-worker");
    expect(doc.workers_dev).toBe(true);
    expect(doc.observability).toEqual({ enabled: false });
    expect(doc.vars).toEqual({ ENVIRONMENT: "production" });
    expect(doc.kv_namespaces).toEqual([{ binding: "MY_KV", id: "abc123" }]);
    expect(doc.r2_buckets).toEqual([{ binding: "MY_BUCKET", bucket_name: "my-bucket" }]);
    expect(doc.triggers).toEqual({ crons: ["0 0 * * *"] });
    expect(doc.routes).toEqual([{ pattern: "example.com/*", zone_name: "example.com" }]);
    expect(doc.env).toEqual({ production: { workers_dev: false, vars: { ENVIRONMENT: "production" } } });
  });

  test("throws TomlParseError on malformed input, rather than a generic error", () => {
    expect(() => parseTOML("a = ")).toThrow(TomlParseError);
    expect(() => parseTOML("[unterminated")).toThrow(TomlParseError);
    expect(() => parseTOML('a = "unterminated')).toThrow(TomlParseError);
  });

  test("is pure: no fs/network globals referenced (Workers-safety smoke check)", () => {
    const src = readFileSync(fileURLToPath(new URL("./toml.ts", import.meta.url)), "utf-8");
    expect(src).not.toMatch(/\brequire\(/);
    expect(src).not.toMatch(/\bfetch\(/);
    expect(src).not.toMatch(/\bimport\.meta\.url\b/);
  });
});
