import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { flapsUp, flapsDown } from "./flaps";
import { MACHINES_CONTRACT, normalizeEndpoint, contractKeys } from "./machines-contract";

// Fidelity check: every flaps endpoint the flyApply applier depends on
// (MACHINES_CONTRACT) must be served by the pinned mudflaps image — the twin of
// the Sprites contract ⊆ spritzer check (#808 T3). mudflaps enumerates its
// implemented paths at `/_mudflaps/health` and answers roadmap endpoints
// (machines/{id}/signal, /exec, /ps) with 501; flyApply must never depend on one.
// Docker required; skipped in CI unless FLY_DOCKER=1 (GitHub runners have Docker,
// so relying on absence would pull the image on every run).

const CONTAINER = "chant-mudflaps-contract-it";
const PORT = 4283;

let available = false;
let endpoint = "";

/** Parse a mudflaps health `implemented` entry ("METHOD path (note)") to a normalized key. */
function normalizeImplemented(entry: string): string {
  const stripped = entry.replace(/\s*\(.*\)\s*$/, "").trim();
  const sp = stripped.indexOf(" ");
  return normalizeEndpoint(stripped.slice(0, sp), stripped.slice(sp + 1));
}

beforeAll(async () => {
  if (process.env.CI && !process.env.FLY_DOCKER) {
    available = false;
    return;
  }
  try {
    const up = await flapsUp({ name: CONTAINER, port: PORT, timeoutMs: 30_000 });
    endpoint = up.endpoint;
    available = true;
  } catch {
    available = false;
  }
}, 60_000);

afterAll(async () => {
  if (available) await flapsDown({ name: CONTAINER });
});

describe("Machines contract ⊆ mudflaps implemented paths", () => {
  test("the pinned mudflaps serves every endpoint flyApply depends on", async (ctx) => {
    if (!available) ctx.skip();

    const res = await fetch(`${endpoint}/_mudflaps/health`);
    expect(res.ok).toBe(true);
    const health = (await res.json()) as { implemented?: string[] };
    expect(Array.isArray(health.implemented)).toBe(true);

    const served = new Set((health.implemented ?? []).map(normalizeImplemented));

    const missing = [...contractKeys()].filter((k) => !served.has(k));
    // A non-empty list means flyApply calls something mudflaps can't serve — a
    // real fidelity gap between the applier and the pinned emulator.
    expect(missing, `mudflaps is missing contract endpoints: ${missing.join(", ")}`).toEqual([]);
  });

  test("flyApply never depends on a mudflaps roadmap (501) endpoint", async (ctx) => {
    if (!available) ctx.skip();
    const res = await fetch(`${endpoint}/_mudflaps/health`);
    const health = (await res.json()) as { unimplemented?: string[] };
    const roadmap = new Set((health.unimplemented ?? []).map(normalizeImplemented));

    for (const e of MACHINES_CONTRACT) {
      const key = normalizeEndpoint(e.method, e.path);
      expect(roadmap.has(key), `${e.op} → ${e.method} ${e.path} is a mudflaps roadmap endpoint`).toBe(false);
    }
  });
});
