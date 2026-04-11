/**
 * Test file template generators for init-lexicon scaffold.
 */

export function generatePluginTestTs(name: string, names: { pluginVarName: string }): string {
  return `import { describe, expect, it } from "vitest";
import { ${names.pluginVarName} } from "./plugin";
import { isLexiconPlugin } from "@intentius/chant/lexicon";

describe("${name} plugin", () => {
  it("is a valid LexiconPlugin", () => {
    expect(isLexiconPlugin(${names.pluginVarName})).toBe(true);
  });

  it("has the correct name", () => {
    expect(${names.pluginVarName}.name).toBe("${name}");
  });

  it("has a serializer", () => {
    expect(${names.pluginVarName}.serializer).toBeDefined();
  });
});
`;
}

export function generateSerializerTestTs(name: string, names: { serializerVarName: string }): string {
  return `import { describe, expect, it } from "vitest";
import { ${names.serializerVarName} } from "./serializer";

describe("${name} serializer", () => {
  it("serializes an empty map to valid JSON", () => {
    const result = ${names.serializerVarName}.serialize(new Map());
    expect(typeof result).toBe("string");
    expect(() => JSON.parse(result)).not.toThrow();
  });

  it("has the correct name", () => {
    expect(${names.serializerVarName}.name).toBe("${name}");
  });
});
`;
}

export function generateCompletionsTestTs(): string {
  return `import { describe, expect, it } from "vitest";
import { completions } from "./completions";

describe("LSP completions", () => {
  it("returns an array", () => {
    // TODO: Replace with a real CompletionContext
    const result = completions({} as any);
    expect(Array.isArray(result)).toBe(true);
  });
});
`;
}

export function generateHoverTestTs(): string {
  return `import { describe, expect, it } from "vitest";
import { hover } from "./hover";

describe("LSP hover", () => {
  it("returns undefined for unknown context", () => {
    // TODO: Replace with a real HoverContext
    const result = hover({} as any);
    expect(result).toBeUndefined();
  });
});
`;
}
