/**
 * The `predictBehaviour` activity over this lexicon's own example (#2358).
 *
 * `packages/core`'s activity builds a project in-process, assembles the
 * request the way `lifecycle plan` assembles a deep read's, and hands it to
 * the one configured lexicon that implements the fourth method. This holds
 * that path to the example project — the same estate the golden request is
 * built from — against a command engine written to a temp dir, the transport
 * augur dials.
 *
 * What it proves that the unit tests in core cannot: the activity finds augur
 * among the example's configured lexicons, every declared entity reaches
 * `entities` or `unpredicted` (the example's own Op included, declined by
 * name), the declared path claims edge coverage `unknown` rather than
 * `complete`, and two runs of the activity at two levels produce a delta whose
 * every pair is marked `mixed-level` rather than differenced.
 */

import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isBehaviourRefusalReport, type BehaviourReport } from "@intentius/chant/behaviour";
import { behaviourDelta, renderBehaviourFinding, type BehaviourDeltaReport } from "@intentius/chant/behaviour-delta";
import { predictDeclared } from "@intentius/chant/op/activities/predict-behaviour";
import { EXAMPLE_ROOT } from "./__fixtures__/example-request";

/**
 * A command engine: reads the request from stdin, answers every node with a
 * figure whose rate scales with the level's rps, and states a total. Plain
 * JavaScript because the child gets `PATH` alone and dials `node` by name.
 */
function scriptEngine(): string {
  const dir = mkdtempSync(join(tmpdir(), "augur-pr-finding-"));
  const file = join(dir, "engine.mjs");
  writeFileSync(
    file,
    `
let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  const request = JSON.parse(raw);
  const rps = /(\\d+)\\s*rps/.exec(request.traffic);
  const intensity = rps ? Number(rps[1]) / 100 : 1;
  const figures = {};
  let total = 0;
  for (const node of request.nodes) {
    const perHour = Number((0.01 * intensity).toFixed(4));
    total += perHour;
    figures[node.name] = {
      perHour,
      currency: "USD",
      headroom: { cpu: 0.5, latency: 0.4 },
      errorRate: 0.001,
      resilience: { failure: "one zone lost", verdict: node.kind === "database" ? "degrades" : "survives" },
    };
  }
  process.stdout.write(JSON.stringify({
    engine: "script-engine", version: "0.0.1", tolerance: "±30%", basis: "modeled",
    total: { perHour: Number(total.toFixed(4)), currency: "USD" }, figures,
  }));
});
`,
  );
  chmodSync(file, 0o755);
  return `${process.execPath} ${file}`;
}

describe("the predictBehaviour activity over the example project (#2358)", () => {
  const saved = process.env.CHANT_BEHAVIOUR_ENGINE_AUGUR;
  afterEach(() => {
    if (saved === undefined) delete process.env.CHANT_BEHAVIOUR_ENGINE_AUGUR;
    else process.env.CHANT_BEHAVIOUR_ENGINE_AUGUR = saved;
  });

  it("finds augur among the configured lexicons, predicts through it, and accounts for every entity", async () => {
    process.env.CHANT_BEHAVIOUR_ENGINE_AUGUR = scriptEngine();
    const result = await predictDeclared(EXAMPLE_ROOT, { environment: "dev", traffic: "100 rps, p50" });
    expect(isBehaviourRefusalReport(result)).toBe(false);
    const report = result as BehaviourReport;

    expect(report.meta.engine).toBe("script-engine");
    expect(report.meta.at.traffic).toBe("100 rps, p50");
    expect(Object.keys(report.entities).sort()).toEqual(["arrivalsQueue", "arrièreQueue", "databaseDb", "receipts"]);

    // The example's own Op is declared unmapped by the coverage table and
    // lands as a decline naming the kind — a row, not a zero and not a drop.
    const op = Object.entries(report.unpredicted ?? {}).find(([, u]) => u.type === "Chant::Op");
    expect(op).toBeDefined();
    expect(op![1].reason).toBe("unsupported-kind");
    expect(op![1].detail).toContain("an Op is a procedure chant runs");
    expect(report.unpredicted?.networkVpc?.reason).toBe("unsupported-kind");
    expect(report.unpredicted?.steady?.detail).toContain("the request's own input");
  });

  it("states the declared path's edge coverage as unknown, never complete", async () => {
    // References are exhaustive and containment is absent, and the contract
    // has no field to name a containment gap — see the activity's module doc.
    process.env.CHANT_BEHAVIOUR_ENGINE_AUGUR = scriptEngine();
    const report = (await predictDeclared(EXAMPLE_ROOT, { environment: "dev", traffic: "100 rps, p50" })) as BehaviourReport;
    expect(report.meta.edgeCoverage.verdict).toBe("unknown");
    // Predicting the same estate twice makes a delta whose resilience is
    // shown per side and not compared, which is the consequence that matters.
    const again = await predictDeclared(EXAMPLE_ROOT, { environment: "dev", traffic: "100 rps, p50" });
    const delta = behaviourDelta({ label: "base", result: report }, { label: "head", result: again }) as BehaviourDeltaReport;
    expect(delta.resilienceComparable).toBe(false);
    expect(renderBehaviourFinding(delta, { env: "dev", op: "pr-behaviour" })).toContain("**not compared**");
  });

  it("refuses by name with no engine configured, and the activity passes the refusal through unchanged", async () => {
    delete process.env.CHANT_BEHAVIOUR_ENGINE_AUGUR;
    const saved = { chant: process.env.CHANT_BEHAVIOUR_ENGINE, bare: process.env.BEHAVIOUR_ENGINE };
    delete process.env.CHANT_BEHAVIOUR_ENGINE;
    delete process.env.BEHAVIOUR_ENGINE;
    try {
      const result = await predictDeclared(EXAMPLE_ROOT, { environment: "dev", traffic: "100 rps, p50" });
      expect(isBehaviourRefusalReport(result)).toBe(true);
      if (!isBehaviourRefusalReport(result)) return;
      expect(result.refusal.cause).toBe("no-engine");
      expect(result.refusal.remedy).toContain("CHANT_BEHAVIOUR_ENGINE");
    } finally {
      if (saved.chant !== undefined) process.env.CHANT_BEHAVIOUR_ENGINE = saved.chant;
      if (saved.bare !== undefined) process.env.BEHAVIOUR_ENGINE = saved.bare;
    }
  });

  it("two runs at two levels make a delta whose every pair is marked mixed-level, never differenced", async () => {
    process.env.CHANT_BEHAVIOUR_ENGINE_AUGUR = scriptEngine();
    const steady = await predictDeclared(EXAMPLE_ROOT, { environment: "dev", traffic: "100 rps, p50" });
    const peak = await predictDeclared(EXAMPLE_ROOT, { environment: "dev", traffic: "1000 rps, p99" });
    const delta = behaviourDelta({ label: "base", result: steady }, { label: "head", result: peak }) as BehaviourDeltaReport;
    expect(delta.kind).toBe("delta");
    const priced = delta.rows.filter((r) => r.base && r.head);
    expect(priced.length).toBe(4);
    for (const row of priced) {
      expect(row.kind).toBe("marked");
      expect(row.mismatches).toEqual(["mixed-level"]);
      expect(row.deltaPerHour).toBeUndefined();
    }
    expect(delta.rows.filter((r) => r.kind === "declined").length).toBeGreaterThan(0);
    const body = renderBehaviourFinding(delta, { env: "dev", op: "pr-behaviour" });
    expect(body).toContain("marked: mixed-level");
    expect(body).toContain("No pair is comparable, so no delta is summed.");
    expect(body).toContain("script-engine 0.0.1 · ±30% · modeled");
  });
});
