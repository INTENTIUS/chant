import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { spritesUp, spritesDown } from "./sprites-emulator";
import { SPRITES_CONTRACT, normalizeEndpoint, contractKeys } from "./sprites-contract";

// Fidelity check (#808 T3): every endpoint the fly sprite activities depend on
// (SPRITES_CONTRACT) must be served by the pinned spritzer image. Sprites has no
// OpenAPI to diff, so spritzer's `/_spritzer/health` implemented-paths list is
// the machine-readable oracle. If an activity ever calls something the emulator
// doesn't model, this fails instead of the tests silently passing against a
// partial fake. Docker required; skipped in CI unless SPRITES_DOCKER=1 (GitHub
// runners have Docker, so relying on absence would pull the image every run).

const CONTAINER = "chant-spritzer-contract-it";
const PORT = 4293;

let available = false;
let endpoint = "";

/** Parse a spritzer health `implemented` entry ("METHOD path (note)") to a normalized key. */
function normalizeImplemented(entry: string): string {
  const stripped = entry.replace(/\s*\(.*\)\s*$/, "").trim();
  const sp = stripped.indexOf(" ");
  const method = stripped.slice(0, sp);
  const path = stripped.slice(sp + 1);
  return normalizeEndpoint(method, path);
}

beforeAll(async () => {
  if (process.env.CI && !process.env.SPRITES_DOCKER) {
    available = false;
    return;
  }
  try {
    const up = await spritesUp({ name: CONTAINER, port: PORT, timeoutMs: 30_000 });
    endpoint = up.endpoint;
    available = true;
  } catch {
    available = false;
  }
}, 60_000);

afterAll(async () => {
  if (available) await spritesDown({ name: CONTAINER });
});

describe("Sprites contract ⊆ spritzer implemented paths (#808 T3)", () => {
  test("the pinned spritzer serves every endpoint the fly activities depend on", async (ctx) => {
    if (!available) ctx.skip();

    const res = await fetch(`${endpoint}/_spritzer/health`);
    expect(res.ok).toBe(true);
    const health = (await res.json()) as { implemented?: string[] };
    expect(Array.isArray(health.implemented)).toBe(true);

    const served = new Set((health.implemented ?? []).map(normalizeImplemented));

    const missing = [...contractKeys()].filter((k) => !served.has(k));
    // A non-empty list means an activity calls something spritzer can't serve —
    // a real fidelity gap between the contract and the pinned emulator.
    expect(missing, `spritzer is missing contract endpoints: ${missing.join(", ")}`).toEqual([]);
  });

  test("each contract endpoint maps to a served path (per-activity report)", async (ctx) => {
    if (!available) ctx.skip();
    const res = await fetch(`${endpoint}/_spritzer/health`);
    const health = (await res.json()) as { implemented?: string[] };
    const served = new Set((health.implemented ?? []).map(normalizeImplemented));

    for (const e of SPRITES_CONTRACT) {
      const key = normalizeEndpoint(e.method, e.path);
      expect(served.has(key), `${e.activity} → ${e.method} ${e.path} not served by spritzer`).toBe(true);
    }
  });
});
