/**
 * A fixture engine, standing in for whatever #2359's adapter will talk to.
 *
 * It is not a price model and does not pretend to be one: the numbers below
 * are made up, they are labelled `modeled` with a stated tolerance, and they
 * exist so the lexicon's own behaviour — screening, resolving, serializing,
 * translating, declining — can be exercised end to end without a network.
 * `lexicons/augur/src/predict-behaviour.ts` contains no arithmetic on money at
 * all, so nothing this file computes ever reaches a real report.
 *
 * Two properties it must have, both of them the shared conformance suite's
 * requirements rather than this fixture's preferences:
 *
 *  - **The traffic level is read, not echoed.** `probeTrafficLevel` asks at two
 *    levels and requires the answers to differ.
 *  - **The figures move with edge *degree*, not with a connected/not-connected
 *    boolean.** `probeReadsEdges` drops exactly one edge from a two-edge graph
 *    and requires the answer to move. A boolean would be unchanged for any node
 *    that still has an edge left, and the probe would go red for a lexicon that
 *    genuinely reads the graph.
 */

import type { BehaviourEngine, EngineFigure, EngineOutcome } from "../engine";
import type { EngineKind } from "../mapping";
import type { EngineRequest } from "../request";

/** How the fixture names itself. Provenance is per entity, so this is on every block. */
export const FIXTURE_ENGINE_NAME = "augur-fixture";
export const FIXTURE_ENGINE_VERSION = "0.3.1";
export const FIXTURE_ENGINE_TOLERANCE = "±20%";

/** Per-kind baselines at the fixture's 100 rps reference level, on an unconnected node. */
const BASELINE: Record<EngineKind, { perHour: number; cpu: number; latency: number }> = {
  compute: { perHour: 0.0416, cpu: 0.62, latency: 0.41 },
  serverless: { perHour: 0.0072, cpu: 0.88, latency: 0.35 },
  database: { perHour: 0.272, cpu: 0.35, latency: 0.28 },
  cache: { perHour: 0.068, cpu: 0.71, latency: 0.66 },
  queue: { perHour: 0.004, cpu: 0.93, latency: 0.81 },
  "object-store": { perHour: 0.0023, cpu: 0.96, latency: 0.74 },
  "block-store": { perHour: 0.0137, cpu: 0.9, latency: 0.58 },
  "load-balancer": { perHour: 0.0225, cpu: 0.55, latency: 0.49 },
  cdn: { perHour: 0.085, cpu: 0.82, latency: 0.88 },
};

/** Six significant figures, so a float comparison in a test is stable. */
const round = (n: number): number => Number(n.toPrecision(6));

/**
 * How busy the stated level is against the fixture's 100 rps reference. Read,
 * not echoed: a level naming no rate is treated as the reference, which is the
 * fixture's own convention and not a chant-wide one — `behaviour.ts` parses the
 * level nowhere and neither does the lexicon.
 */
export function trafficIntensity(traffic: string): number {
  const rps = /(\d+(?:\.\d+)?)\s*rps/i.exec(traffic);
  return rps ? Number(rps[1]) / 100 : 1;
}

/** What the fixture engine can be told to do instead of answering. */
export interface FixtureEngineOptions {
  /** Refuse every request this way, the three shapes an engine that answered can refuse in. */
  refuse?: { cause: "engine-unreachable" | "engine-out-of-credit" | "engine-over-quota"; detail: string };
  /** Node names the engine declines, with its reason for each. */
  decline?: Record<string, string>;
  /** Node names the engine answers about in neither map — an engine losing a node. */
  lose?: readonly string[];
}

/**
 * Build the fixture engine.
 *
 * Deterministic: the same request gives the same answer, which is what
 * `probeEdgelessConsistency` checks and what a golden request is only worth
 * anything against.
 */
export function fixtureEngine(options: FixtureEngineOptions = {}): BehaviourEngine {
  return {
    async predict(request: EngineRequest): Promise<EngineOutcome> {
      if (options.refuse) return { ok: false, failure: options.refuse };

      const intensity = trafficIntensity(request.traffic);
      const degree = new Map<string, number>();
      for (const edge of request.edges) {
        degree.set(edge.from, (degree.get(edge.from) ?? 0) + 1);
        degree.set(edge.to, (degree.get(edge.to) ?? 0) + 1);
      }

      const lost = new Set(options.lose ?? []);
      const figures: Record<string, EngineFigure> = {};
      let total = 0;

      for (const node of request.nodes) {
        if (lost.has(node.name)) continue;
        if (options.decline && node.name in options.decline) continue;
        const base = BASELINE[node.kind];
        const load = degree.get(node.name) ?? 0;
        // Traffic spends headroom on every node; each edge spends it again, so
        // removing one edge moves both of its ends.
        const spend = (free: number): number => Math.max(0, Math.min(1, 1 - (1 - free) * intensity));
        const perHour = round(base.perHour * intensity * (1 + load * 0.1));
        total += perHour;
        figures[node.name] = {
          perHour,
          currency: "USD",
          headroom: {
            cpu: round(spend(base.cpu) ** (1 + load)),
            latency: round(spend(base.latency) ** (1 + load)),
          },
          errorRate: round(Math.min(1, 0.0005 * intensity * (1 + load))),
          resilience: {
            failure: "one zone lost",
            // A single-instance database degrades on a lost zone; everything
            // else the fixture models survives one. A verdict needs its named
            // failure to mean anything, which is why `failure` is above it.
            verdict: node.kind === "database" ? (load > 1 ? "fails" : "degrades") : "survives",
            ...(node.kind === "database"
              ? { note: "single-instance in the request's region; a failover costs about 90 seconds" }
              : {}),
          },
          ...(node.kind === "compute" && node.size === "t3.medium"
            ? { rightSize: { suggestion: "t3.small", reason: "CPU headroom at the stated level" } }
            : {}),
        };
      }

      return {
        ok: true,
        answer: {
          engine: FIXTURE_ENGINE_NAME,
          version: FIXTURE_ENGINE_VERSION,
          tolerance: FIXTURE_ENGINE_TOLERANCE,
          basis: "modeled",
          total: { perHour: round(total), currency: "USD" },
          figures,
          ...(options.decline ? { declined: options.decline } : {}),
        },
      };
    },
  };
}
