import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { SPRITES_CONTRACT, normalizeEndpoint, contractKeys } from "./sprites-contract";

describe("SPRITES_CONTRACT", () => {
  test("covers every sprite activity that calls the Sprites API", () => {
    const activities = new Set(SPRITES_CONTRACT.map((e) => e.activity));
    // The six ./sprites.ts activities that make an HTTP/WS call.
    expect(activities).toEqual(
      new Set([
        "spriteCreate",
        "spriteExec",
        "spriteCheckpoint",
        "listCheckpoints",
        "spriteRestore",
        "spriteDestroy",
      ]),
    );
  });

  test("every entry has a v1 path and a known method", () => {
    for (const e of SPRITES_CONTRACT) {
      expect(e.path.startsWith("/v1/sprites")).toBe(true);
      expect(["GET", "POST", "DELETE", "WS"]).toContain(e.method);
    }
  });

  test("normalizeEndpoint collapses param names and maps WS→GET", () => {
    // {cp} and {cid} must compare equal (spritzer spells it {cid}).
    expect(normalizeEndpoint("POST", "/v1/sprites/{id}/checkpoints/{cp}/restore")).toBe(
      normalizeEndpoint("POST", "/v1/sprites/{id}/checkpoints/{cid}/restore"),
    );
    // The exec WebSocket is registered as a GET on the emulator.
    expect(normalizeEndpoint("WS", "/v1/sprites/{id}/exec")).toBe("GET /v1/sprites/{}/exec");
  });

  test("contractKeys is the deduped normalized set", () => {
    const keys = contractKeys();
    expect(keys.has("POST /v1/sprites")).toBe(true);
    expect(keys.has("DELETE /v1/sprites/{}")).toBe(true);
    expect(keys.size).toBe(SPRITES_CONTRACT.length);
  });

  test("every contract path segment appears in the sprites.ts source (drift anchor)", () => {
    // Anchors the hand-authored contract to the activity implementations: if an
    // activity's endpoint path changes, a segment goes missing here and the
    // contract must be updated in the same change.
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "sprites.ts"), "utf-8");
    const segments = new Set(
      SPRITES_CONTRACT.flatMap((e) =>
        e.path.split("/").filter((s) => s.length > 0 && !s.startsWith("{")),
      ),
    );
    for (const seg of segments) {
      expect(src, `path segment "${seg}" from the contract is absent from sprites.ts`).toContain(seg);
    }
  });
});
