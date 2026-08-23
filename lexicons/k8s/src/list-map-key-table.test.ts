import { describe, test, expect, afterEach, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  listMapKeyTablePath,
  loadListMapKeyTable,
  resetListMapKeyTableCache,
  schemaListMapOrderKey,
} from "./deep-observe-hooks";
import type { DeepArrayElement } from "@intentius/chant/lexicon";

/**
 * chant #1476 — the generated table is data, not a hard dependency. Present,
 * it drives list identity; absent, `schemaListMapOrderKey` degrades to the
 * hand-written conventions with one warning, and never throws.
 */

function el(pattern: string, element: unknown): DeepArrayElement {
  return { entityType: "K8s::Apps::Deployment", pattern, path: pattern, element, index: 0, side: "live" };
}

describe("list-map-keys table loading (#1476)", () => {
  afterEach(() => {
    resetListMapKeyTableCache();
    vi.restoreAllMocks();
  });

  test("the generated table exists where the loader looks", () => {
    expect(listMapKeyTablePath()).toMatch(/generated[\\/]list-map-keys\.json$/);
    expect(existsSync(listMapKeyTablePath())).toBe(true);
  });

  test("table present: spec-declared keys identify lists the conventions miss", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const table = loadListMapKeyTable();
    expect(table.conditions).toBeDefined();
    expect(warn).not.toHaveBeenCalled();

    resetListMapKeyTableCache();
    expect(schemaListMapOrderKey(el("status.conditions", { type: "Ready", status: "True" }))).toBe("Ready");
    expect(warn).not.toHaveBeenCalled();
  });

  test("table absent: falls back to the conventions, warns once, never throws", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const missing = join(tmpdir(), "chant-1476-does-not-exist", "list-map-keys.json");

    const table = loadListMapKeyTable(missing);
    expect(table).toEqual({});
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0][0]);
    expect(message).toContain("npm run generate");
    expect(message).toContain(missing);

    // Seed the cache with the empty table, as the first lookup would have.
    resetListMapKeyTableCache(table);

    // Hand-written conventions still apply ...
    expect(schemaListMapOrderKey(el("spec.template.spec.containers", { name: "app" }))).toBe("app");
    expect(schemaListMapOrderKey(el("spec.template.spec.containers[].env", { name: "FOO" }))).toBe("FOO");
    // ... and lists only the spec knows about fall through to undefined, not a throw.
    expect(() => schemaListMapOrderKey(el("status.conditions", { type: "Ready" }))).not.toThrow();
    expect(schemaListMapOrderKey(el("status.conditions", { type: "Ready" }))).toBeUndefined();

    // The warning was emitted by the load, not per element.
    expect(warn).toHaveBeenCalledTimes(1);
  });

  test("table unreadable: treated like absent", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const dir = mkdtempSync(join(tmpdir(), "chant-1476-"));
    try {
      const corrupt = join(dir, "list-map-keys.json");
      writeFileSync(corrupt, "{ not json");
      expect(loadListMapKeyTable(corrupt)).toEqual({});
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain("unreadable");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
