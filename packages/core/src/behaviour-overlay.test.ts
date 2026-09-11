/**
 * The overlay projection (#2360), held to behold's reader.
 *
 * behold reads `meta._behaviour` as `{ engine?, version?, at?, total?,
 * refusal? }` and short-circuits on `refusal`. A bare `BehaviourRefusal` put
 * there has `reason` and `remedy` at its top level and no `refusal` key, so
 * the reader finds no refusal, then no engine, and drops the meta as
 * "meta.engine missing". The shape assertions below are that reader's rules,
 * restated, and they are what gates. Point `CHANT_BEHOLD_CHECKOUT` at a behold
 * checkout and the last block runs that reader itself against the same values,
 * which is how the restatement is checked for drift.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  behaviourRefusal,
  behaviourReport,
  noBehaviourEngineRefusal,
  predictedRate,
  type PredictedBehaviour,
} from "./behaviour";
import { BEHAVIOUR_OVERLAY_ATTR, behaviourOverlay } from "./behaviour-overlay";

/**
 * Opt-in: behold's own reader, from a checkout the runner names.
 *
 * The assertions in the first block restate that reader's rules, which is what
 * gates. This block runs the real thing, and is how somebody with both
 * repositories checked out confirms the restatement has not drifted from
 * `src/behaviour.ts` in INTENTIUS/behold. Same shape as the opt-in blocks
 * that need a real dogwood or a real helm: an env var plus the artefact
 * actually being there, and never gating, because CI has one repository.
 */
const BEHOLD_READER = process.env.CHANT_BEHOLD_CHECKOUT
  ? join(process.env.CHANT_BEHOLD_CHECKOUT, "src", "behaviour.ts")
  : undefined;
const haveBeholdReader = BEHOLD_READER !== undefined && existsSync(BEHOLD_READER);

const block: PredictedBehaviour = {
  at: { traffic: "100 rps, p50" },
  cost: predictedRate(0.0416, "USD"),
  headroom: { cpu: 0.6, latency: 0.4 },
  errorRate: 0.0005,
  resilience: { failure: "one zone lost", verdict: "survives" },
  provenance: { engine: "fixture", version: "0.0.1", tolerance: "±20%", basis: "modeled" },
};

const report = behaviourReport(
  { entityNames: ["web", "role"], traffic: "100 rps, p50", edgeCoverage: { verdict: "complete" } },
  { engine: "fixture", version: "0.0.1", total: predictedRate(0.0416, "USD") },
  { web: block },
  { role: { reason: "unsupported-kind", detail: "a role is a grant" } },
);

describe("behaviourOverlay", () => {
  it("puts the whole refusal report on meta, so behold finds a `refusal` key", () => {
    const overlay = behaviourOverlay(noBehaviourEngineRefusal("terraform"));
    const meta = overlay.meta[BEHAVIOUR_OVERLAY_ATTR] as unknown as Record<string, unknown>;
    // behold's reader: `refusal` present, with a non-empty `reason` and `remedy`.
    expect(meta.refusal).toBeDefined();
    const refusal = meta.refusal as { reason?: string; remedy?: string; cause?: string };
    expect(refusal.reason).toMatch(/CHANT_BEHAVIOUR_ENGINE/);
    expect(refusal.remedy?.length).toBeGreaterThan(0);
    expect(refusal.cause).toBe("no-engine");
    // The envelope stays, so the value says which contract it is in.
    expect(meta.behaviour).toBe("v1");
    // A refusal is present instead of every figure.
    expect(meta.engine).toBeUndefined();
    expect(Object.keys(overlay.attrs)).toEqual([]);
  });

  it("does not flatten a refusal to its reason and remedy, which behold would drop", () => {
    const bare = behaviourRefusal({ cause: "no-engine", reason: "no engine", remedy: "set it" }).refusal;
    // What the contract doc once said to put there: the bare refusal. Its
    // top level has no `refusal` key, which is the shape behold rejects.
    expect("refusal" in bare).toBe(false);
    const meta = behaviourOverlay(noBehaviourEngineRefusal("terraform")).meta[BEHAVIOUR_OVERLAY_ATTR];
    expect("refusal" in meta).toBe(true);
  });

  it("puts the report's meta on meta and each entity's block on its node", () => {
    const overlay = behaviourOverlay(report);
    const meta = overlay.meta[BEHAVIOUR_OVERLAY_ATTR] as unknown as Record<string, unknown>;
    expect(meta.engine).toBe("fixture");
    expect(meta.version).toBe("0.0.1");
    expect(meta.at).toEqual({ traffic: "100 rps, p50" });
    expect(meta.total).toEqual({ rate: "per-hour", perHour: 0.0416, currency: "USD" });
    expect(meta.refusal).toBeUndefined();
    // The coverage the verdicts were computed over rides along for a reader
    // that wants it; behold's reader ignores it.
    expect((meta.edgeCoverage as { verdict: string }).verdict).toBe("complete");
    expect(Object.keys(overlay.attrs)).toEqual(["web"]);
    expect(overlay.attrs.web[BEHAVIOUR_OVERLAY_ATTR]).toBe(block);
  });

  it("gives an unpredicted entity no block at all, rather than one full of zeroes", () => {
    const overlay = behaviourOverlay(report);
    expect(Object.prototype.hasOwnProperty.call(overlay.attrs, "role")).toBe(false);
  });

  it("is safe for an entity named after a prototype member", () => {
    // `Object.create(null)` and assignment, not a literal: `{ __proto__: x }`
    // sets the prototype rather than adding a key, so the entity a lexicon
    // believed it had reported would not be there to project. This is the
    // same hazard the projection guards on its own writing side.
    const entities = Object.create(null) as Record<string, PredictedBehaviour>;
    for (const name of ["__proto__", "constructor"]) entities[name] = block;
    const named = behaviourReport(
      { entityNames: ["__proto__", "constructor"], traffic: "100 rps, p50", edgeCoverage: { verdict: "complete" } },
      { engine: "fixture", version: "0.0.1" },
      entities,
    );
    const overlay = behaviourOverlay(named);
    expect(Object.keys(overlay.attrs).sort()).toEqual(["__proto__", "constructor"]);
    expect(overlay.attrs.__proto__[BEHAVIOUR_OVERLAY_ATTR]).toBe(block);
  });
});

describe.skipIf(!haveBeholdReader)("behold's own reader accepts the projection (opt-in)", () => {
  it("validates a refusal meta as a refusal, and a report meta as a report", async () => {
    const behold = (await import(/* @vite-ignore */ BEHOLD_READER!)) as {
      validateBehaviourMeta(v: unknown): { ok: true; value: unknown } | { ok: false; reason: string };
      validateBehaviourBlock(v: unknown): { ok: true; value: unknown } | { ok: false; reason: string };
    };
    const refused = behold.validateBehaviourMeta(
      behaviourOverlay(noBehaviourEngineRefusal("terraform")).meta[BEHAVIOUR_OVERLAY_ATTR],
    );
    expect(refused.ok, refused.ok ? "" : refused.reason).toBe(true);
    if (refused.ok) expect(Object.keys(refused.value as object)).toEqual(["refusal"]);

    const reported = behold.validateBehaviourMeta(behaviourOverlay(report).meta[BEHAVIOUR_OVERLAY_ATTR]);
    expect(reported.ok, reported.ok ? "" : reported.reason).toBe(true);
    if (reported.ok) expect((reported.value as { engine: string }).engine).toBe("fixture");

    const painted = behold.validateBehaviourBlock(behaviourOverlay(report).attrs.web[BEHAVIOUR_OVERLAY_ATTR]);
    expect(painted.ok, painted.ok ? "" : painted.reason).toBe(true);
  });

  it("drops a bare refusal, which is why the whole report goes on meta", async () => {
    const behold = (await import(/* @vite-ignore */ BEHOLD_READER!)) as {
      validateBehaviourMeta(v: unknown): { ok: true } | { ok: false; reason: string };
    };
    const bare = behold.validateBehaviourMeta(noBehaviourEngineRefusal("terraform").refusal);
    expect(bare.ok).toBe(false);
    if (!bare.ok) expect(bare.reason).toBe("meta.engine missing");
  });
});
