import { describe, test, expect } from "vitest";
import { flywayHover } from "./hover";
import type { HoverContext } from "@intentius/chant/lsp/types";

function makeCtx(overrides: Partial<HoverContext>): HoverContext {
  return {
    uri: "file:///test.ts",
    content: "",
    position: { line: 0, character: 0 },
    word: "",
    lineText: "",
    ...overrides,
  };
}

describe("flywayHover", () => {
  test("returns hover info for FlywayConfig", () => {
    const ctx = makeCtx({ word: "FlywayConfig" });
    const info = flywayHover(ctx);

    expect(info).toBeDefined();
    expect(info!.contents).toContain("FlywayConfig");
    expect(info!.contents).toContain("Flyway::Config");
    expect(info!.contents).toContain("[flyway]");
  });

  test("returns undefined for unknown word", () => {
    const ctx = makeCtx({ word: "NotARealResource12345" });
    const info = flywayHover(ctx);
    expect(info).toBeUndefined();
  });

  test("returns undefined for empty word", () => {
    const ctx = makeCtx({ word: "" });
    const info = flywayHover(ctx);
    expect(info).toBeUndefined();
  });

  test("shows environment context for Environment resource", () => {
    const ctx = makeCtx({ word: "Environment" });
    const info = flywayHover(ctx);

    expect(info).toBeDefined();
    expect(info!.contents).toContain("Environment");
    expect(info!.contents).toContain("[environments.<name>]");
  });

  test("shows resolver context for VaultResolver", () => {
    const ctx = makeCtx({ word: "VaultResolver" });
    const info = flywayHover(ctx);

    expect(info).toBeDefined();
    expect(info!.contents).toContain("Vault");
    expect(info!.contents).toContain("resolvers.vault");
  });
});
