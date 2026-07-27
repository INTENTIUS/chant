import { describe, test, expect } from "vitest";
import { temporalHover } from "./hover";
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

describe("temporalHover", () => {
  test("returns hover info for TemporalNamespace", () => {
    const ctx = makeCtx({ word: "TemporalNamespace" });
    const info = temporalHover(ctx);
    expect(info).toBeDefined();
    expect(info!.contents).toContain("Temporal::Namespace");
    expect(info!.contents).toContain("temporal-setup.sh");
  });

  test("returns hover info for TemporalServer", () => {
    const ctx = makeCtx({ word: "TemporalServer" });
    const info = temporalHover(ctx);
    expect(info!.contents).toContain("docker-compose.yml");
  });

  test("returns hover info for TemporalSchedule", () => {
    const ctx = makeCtx({ word: "TemporalSchedule" });
    const info = temporalHover(ctx);
    expect(info!.contents).toContain("schedules/<id>.ts");
  });

  test("returns hover info for SearchAttribute", () => {
    const ctx = makeCtx({ word: "SearchAttribute" });
    const info = temporalHover(ctx);
    expect(info!.contents).toContain("search-attribute create");
  });

  test("returns undefined for unknown word", () => {
    const ctx = makeCtx({ word: "NotARealResource12345" });
    expect(temporalHover(ctx)).toBeUndefined();
  });

  test("returns undefined for empty word", () => {
    const ctx = makeCtx({ word: "" });
    expect(temporalHover(ctx)).toBeUndefined();
  });
});
