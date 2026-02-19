import { describe, test, expect } from "bun:test";
import {
  writeResourceClass,
  writePropertyClass,
  writeConstructor,
  writeEnumType,
  resolveConstructorType,
} from "./generate-typescript";

describe("writeResourceClass", () => {
  test("generates class with constructor and attributes", () => {
    const lines: string[] = [];
    writeResourceClass(
      lines,
      "Bucket",
      [{ name: "BucketName", type: "string", required: true }],
      [{ name: "Arn", type: "string" }],
    );
    const output = lines.join("\n");
    expect(output).toContain("export declare class Bucket {");
    expect(output).toContain("bucketName: string;");
    expect(output).toContain("readonly arn: string;");
    expect(output).toContain("}");
  });

  test("applies remap to attribute types", () => {
    const lines: string[] = [];
    const remap = new Map([["CustomType", "BucketConfig"]]);
    writeResourceClass(
      lines,
      "Bucket",
      [],
      [{ name: "Config", type: "CustomType" }],
      remap,
    );
    const output = lines.join("\n");
    expect(output).toContain("readonly config: BucketConfig;");
  });
});

describe("writePropertyClass", () => {
  test("generates class with constructor only", () => {
    const lines: string[] = [];
    writePropertyClass(
      lines,
      "BucketConfig",
      [{ name: "Enabled", type: "boolean", required: false }],
    );
    const output = lines.join("\n");
    expect(output).toContain("export declare class BucketConfig {");
    expect(output).toContain("enabled?: boolean;");
    expect(output).toContain("}");
  });
});

describe("writeConstructor", () => {
  test("empty props produces Record<string, unknown> constructor", () => {
    const lines: string[] = [];
    writeConstructor(lines, [], undefined);
    expect(lines.join("\n")).toContain("constructor(props: Record<string, unknown>);");
  });

  test("sorts required before optional", () => {
    const lines: string[] = [];
    writeConstructor(
      lines,
      [
        { name: "Optional", type: "string", required: false },
        { name: "Required", type: "string", required: true },
      ],
      undefined,
    );
    const output = lines.join("\n");
    const reqIdx = output.indexOf("required:");
    const optIdx = output.indexOf("optional?:");
    expect(reqIdx).toBeLessThan(optIdx);
  });

  test("includes description as JSDoc", () => {
    const lines: string[] = [];
    writeConstructor(
      lines,
      [{ name: "Name", type: "string", required: true, description: "The bucket name" }],
      undefined,
    );
    const output = lines.join("\n");
    expect(output).toContain("/** The bucket name */");
  });
});

describe("writeEnumType", () => {
  test("writes single-line for short enum", () => {
    const lines: string[] = [];
    writeEnumType(lines, "Status", ["active", "inactive"]);
    const output = lines.join("\n");
    expect(output).toContain('export type Status = "active" | "inactive";');
  });

  test("writes multi-line for long enum", () => {
    const lines: string[] = [];
    writeEnumType(lines, "VeryLongTypeName", [
      "value-one-is-very-long",
      "value-two-is-very-long",
      "value-three-is-very-long",
      "value-four-is-very-long",
    ]);
    const output = lines.join("\n");
    expect(output).toContain("export type VeryLongTypeName =");
    expect(output).toContain('  | "value-one-is-very-long"');
  });

  test("sorts values alphabetically", () => {
    const lines: string[] = [];
    writeEnumType(lines, "Order", ["z", "a", "m"]);
    const output = lines.join("\n");
    expect(output).toContain('"a" | "m" | "z"');
  });
});

describe("resolveConstructorType", () => {
  test("passes through primitives", () => {
    expect(resolveConstructorType("string", undefined)).toBe("string");
    expect(resolveConstructorType("number", undefined)).toBe("number");
    expect(resolveConstructorType("boolean", undefined)).toBe("boolean");
    expect(resolveConstructorType("any", undefined)).toBe("any");
  });

  test("normalizes Record<string, any>", () => {
    expect(resolveConstructorType("Record<string, any>", undefined)).toBe("Record<string, unknown>");
  });

  test("handles array types recursively", () => {
    const remap = new Map([["Foo", "Bar"]]);
    expect(resolveConstructorType("Foo[]", remap)).toBe("Bar[]");
    expect(resolveConstructorType("string[]", undefined)).toBe("string[]");
  });

  test("applies remap", () => {
    const remap = new Map([["InternalName", "PublicName"]]);
    expect(resolveConstructorType("InternalName", remap)).toBe("PublicName");
  });

  test("returns type as-is when no remap match", () => {
    expect(resolveConstructorType("UnknownType", new Map())).toBe("UnknownType");
  });
});
