import { describe, expect, test } from "vitest";
import ts from "typescript";
import { schemaToTypeScript, type SchemaToTsOptions } from "./json-schema-to-ts";

/** The declarations plus `type Root = ...`, as a module. */
function module(schema: unknown, options: SchemaToTsOptions = {}): string {
  const { type, declarations } = schemaToTypeScript(schema, { rootName: "Root", ...options });
  return [...declarations.map((d) => `type ${d.name} = ${d.type};`), `type Root = ${type};`].join("\n");
}

const libFiles = new Map<string, ts.SourceFile | undefined>();

/** Type-check `code` in memory; returns the diagnostics' messages. */
function typecheck(code: string): string[] {
  const fileName = "/virtual/check.ts";
  const options: ts.CompilerOptions = { strict: true, noEmit: true, target: ts.ScriptTarget.ES2022, lib: ["lib.es2022.d.ts"] };
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile;
  // The standard library parses once per file, not once per check.
  host.getSourceFile = (name, lang, ...rest) => {
    if (name === fileName) return ts.createSourceFile(name, code, lang);
    if (!libFiles.has(name)) libFiles.set(name, getSourceFile.call(host, name, lang, ...rest));
    return libFiles.get(name);
  };
  const program = ts.createProgram([fileName], options, host);
  return ts
    .getPreEmitDiagnostics(program)
    .filter((d) => d.file?.fileName === fileName)
    .map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
}

/** Whether `value` (TS source) is assignable to the schema's root type. */
function accepts(schema: unknown, value: string, options?: SchemaToTsOptions): string[] {
  return typecheck(`${module(schema, options)}\nexport const v: Root = ${value};\n`);
}

describe("schemaToTypeScript", () => {
  test("scalars, arrays, type arrays and nullable", () => {
    const { type } = schemaToTypeScript({
      type: "object",
      properties: {
        s: { type: "string" },
        i: { type: "integer" },
        b: { type: "boolean" },
        list: { type: "array", items: { type: "string" } },
        maybe: { type: ["string", "null"] },
        legacy: { type: "string", nullable: true },
        any: {},
      },
    }, { openByDefault: false });
    expect(type).toBe(
      [
        "{",
        "  s?: string;",
        "  i?: number;",
        "  b?: boolean;",
        "  list?: string[];",
        "  maybe?: string | null;",
        "  legacy?: string | null;",
        "  any?: unknown;",
        "}",
      ].join("\n"),
    );
  });

  test("required members are required unless allOptional", () => {
    const schema = { type: "object", required: ["name"], properties: { name: { type: "string" } }, additionalProperties: false };
    expect(schemaToTypeScript(schema).type).toContain("  name: string;");
    expect(schemaToTypeScript(schema, { allOptional: true }).type).toContain("  name?: string;");
    expect(accepts(schema, "{}")).not.toEqual([]);
    expect(accepts(schema, "{}", { allOptional: true })).toEqual([]);
  });

  test("$ref into $defs and definitions becomes a named declaration", () => {
    const schema = {
      type: "object",
      properties: {
        image: { $ref: "#/$defs/image" },
        probe: { $ref: "#/definitions/io.k8s.api.core.v1.Probe" },
      },
      $defs: { image: { type: "object", properties: { tag: { type: "string" } }, additionalProperties: false } },
      definitions: { "io.k8s.api.core.v1.Probe": { type: "object", properties: { periodSeconds: { type: "integer" } } } },
    };
    const { type, declarations } = schemaToTypeScript(schema, { namePrefix: "Values" });
    expect(type).toContain("image?: ValuesImage;");
    expect(type).toContain("probe?: ValuesIoK8sApiCoreV1Probe;");
    expect(declarations.map((d) => d.name)).toEqual(["ValuesImage", "ValuesIoK8sApiCoreV1Probe"]);
    expect(accepts(schema, `{ image: { tag: "1.0" }, probe: { periodSeconds: 10 } }`)).toEqual([]);
    expect(accepts(schema, `{ image: { tga: "1.0" } }`).join("\n")).toMatch(/'tga' does not exist/);
  });

  test("recursive references terminate, including a reference to the root", () => {
    const schema = {
      type: "object",
      additionalProperties: false,
      properties: {
        children: { type: "array", items: { $ref: "#/$defs/node" } },
        self: { $ref: "#" },
      },
      $defs: {
        node: { type: "object", additionalProperties: false, properties: { next: { $ref: "#/$defs/node" }, value: { type: "number" } } },
      },
    };
    const { declarations, type } = schemaToTypeScript(schema, { rootName: "Root" });
    expect(declarations).toHaveLength(1);
    expect(declarations[0].type).toContain("next?: Node;");
    expect(type).toContain("self?: Root;");
    expect(accepts(schema, `{ children: [{ value: 1, next: { value: 2 } }], self: {} }`)).toEqual([]);
    expect(accepts(schema, `{ children: [{ value: "x" }] }`)).not.toEqual([]);
  });

  test("keys with slashes, dots, dashes or leading digits are quoted and never renamed", () => {
    const schema = {
      type: "object",
      additionalProperties: false,
      properties: {
        "app.kubernetes.io/name": { type: "string" },
        "use-forwarded-headers": { type: "boolean" },
        "2fa": { type: "boolean" },
        snake_case: { type: "string" },
        HTTPPort: { type: "integer" },
      },
    };
    const { type } = schemaToTypeScript(schema);
    expect(type).toContain(`"app.kubernetes.io/name"?: string;`);
    expect(type).toContain(`"use-forwarded-headers"?: boolean;`);
    expect(type).toContain(`"2fa"?: boolean;`);
    expect(type).toContain(`  snake_case?: string;`);
    expect(type).toContain(`  HTTPPort?: number;`);
    expect(accepts(schema, `{ "app.kubernetes.io/name": "x", "use-forwarded-headers": true }`)).toEqual([]);
  });

  test("objects nested in additionalProperties maps keep their value type", () => {
    const schema = {
      type: "object",
      properties: {
        ports: {
          type: "object",
          additionalProperties: {
            type: "object",
            additionalProperties: false,
            properties: { port: { type: "integer" }, expose: { type: "object", properties: { default: { type: "boolean" } } } },
          },
        },
      },
    };
    const { type } = schemaToTypeScript(schema);
    expect(type).toContain("ports?: Record<string, {");
    expect(accepts(schema, `{ ports: { web: { port: 8000, expose: { default: true } } } }`)).toEqual([]);
    expect(accepts(schema, `{ ports: { web: { prot: 8000 } } }`).join("\n")).toMatch(/'prot' does not exist/);
    expect(accepts(schema, `{ ports: { web: { port: "8000" } } }`)).not.toEqual([]);
  });

  test("a map that also lists members widens its signature to cover them", () => {
    const schema = {
      type: "object",
      properties: { fixed: { type: "string" } },
      additionalProperties: { type: "number" },
    };
    expect(schemaToTypeScript(schema).type).toContain("[key: string]: number | string | undefined;");
    expect(accepts(schema, `{ fixed: "a", other: 1 }`)).toEqual([]);
  });

  test("additionalProperties false closes an object; the default follows openByDefault", () => {
    const closed = { type: "object", additionalProperties: false, properties: { a: { type: "string" } } };
    const unspecified = { type: "object", properties: { a: { type: "string" } } };
    expect(accepts(closed, `{ a: "x", b: 1 }`)).not.toEqual([]);
    expect(accepts(unspecified, `{ a: "x", b: 1 }`)).toEqual([]);
    expect(accepts(unspecified, `{ a: "x", b: 1 }`, { openByDefault: false })).not.toEqual([]);
    // An object with no properties at all stays open either way.
    expect(schemaToTypeScript({ type: "object" }, { openByDefault: false }).type).toBe("Record<string, unknown>");
    expect(schemaToTypeScript({ type: "object", additionalProperties: false }).type).toBe("Record<string, never>");
  });

  test("enum and const become literal unions", () => {
    const schema = {
      type: "object",
      additionalProperties: false,
      properties: {
        policy: { type: "string", enum: ["Always", "IfNotPresent", "Never"] },
        level: { enum: [1, 2, null] },
        kind: { const: "Widget" },
      },
    };
    const { type } = schemaToTypeScript(schema);
    expect(type).toContain(`policy?: "Always" | "IfNotPresent" | "Never";`);
    expect(type).toContain(`level?: 1 | 2 | null;`);
    expect(type).toContain(`kind?: "Widget";`);
    expect(accepts(schema, `{ policy: "Sometimes" }`)).not.toEqual([]);
  });

  test("oneOf and anyOf become unions, allOf an intersection; constraint-only branches are ignored", () => {
    const schema = {
      type: "object",
      additionalProperties: false,
      properties: {
        port: { oneOf: [{ type: "integer" }, { type: "string" }] },
        target: { anyOf: [{ $ref: "#/$defs/a" }, { type: "object", properties: { b: { type: "string" } }, additionalProperties: false }] },
        both: { allOf: [{ type: "object", properties: { x: { type: "string" } } }, { type: "object", properties: { y: { type: "string" } } }] },
        either: { type: "object", properties: { a: { type: "string" }, b: { type: "string" } }, oneOf: [{ required: ["a"] }, { required: ["b"] }] },
      },
      $defs: { a: { type: "object", properties: { a: { type: "string" } }, additionalProperties: false } },
    };
    const { type } = schemaToTypeScript(schema);
    expect(type).toContain("port?: number | string;");
    expect(type).toMatch(/target\?: A \| \{/);
    expect(type).toMatch(/both\?: \{[\s\S]*\} & \{/);
    expect(accepts(schema, `{ port: 80, target: { b: "x" }, both: { x: "1", y: "2" }, either: { a: "1" } }`)).toEqual([]);
    expect(accepts(schema, `{ port: true }`)).not.toEqual([]);
  });

  test("an object base with object alternatives is intersected with their union", () => {
    const schema = {
      type: "object",
      additionalProperties: false,
      properties: { name: { type: "string" } },
      oneOf: [
        { type: "object", properties: { file: { type: "string" } } },
        { type: "object", properties: { url: { type: "string" } } },
      ],
    };
    const { type } = schemaToTypeScript(schema);
    expect(type).toMatch(/^\{[\s\S]*\} & \(\{[\s\S]*\} \| \{[\s\S]*\}\)$/);
    expect(typecheck(`${module(schema)}\nexport type T = Root;`)).toEqual([]);
  });

  test("Kubernetes int-or-string and preserve-unknown-fields", () => {
    const schema = {
      type: "object",
      properties: {
        port: { "x-kubernetes-int-or-string": true },
        config: { type: "object", "x-kubernetes-preserve-unknown-fields": true },
        tuned: { type: "object", "x-kubernetes-preserve-unknown-fields": true, properties: { a: { type: "string" } } },
      },
    };
    const { type } = schemaToTypeScript(schema, { openByDefault: false });
    expect(type).toContain("port?: number | string;");
    expect(type).toContain("config?: Record<string, unknown>;");
    expect(type).toMatch(/tuned\?: \{\n {4}a\?: string;\n {4}\[key: string\]: unknown;/);
  });

  test("descriptions become JSDoc, with comment terminators escaped", () => {
    const { type } = schemaToTypeScript({
      type: "object",
      properties: { a: { type: "string", description: "Either a | b (see */ docs)" }, b: { type: "string", description: "line one\nline two" } },
    });
    expect(type).toContain("/** Either a | b (see *\\/ docs) */");
    expect(type).toContain("   * line two");
    expect(typecheck(`type T = ${type};`)).toEqual([]);
  });

  test("a reference to another document is unknown", () => {
    expect(schemaToTypeScript({ $ref: "https://example.com/schema.json" }).type).toBe("unknown");
    expect(schemaToTypeScript({ $ref: "#/$defs/missing" }).type).toBe("unknown");
  });
});
