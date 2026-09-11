/**
 * The predicted delta and its rendering (#2358).
 *
 * Every rule here is the contract's or the #2358 comment's, and each has a
 * test that fails when the rule is dropped: a declined entity as a row, a
 * mismatched pair as a mark, a refusal as "no prediction", provenance on
 * every figure, a rate as a rate, and resilience uncompared across unequal
 * edge coverage.
 */

import { describe, expect, test } from "vitest";
import {
  behaviourReport,
  noBehaviourEngineRefusal,
  predictedRate,
  renderBehaviourRefusal,
  unreachableBehaviourEngineRefusal,
  type BehaviourEdgeCoverage,
  type BehaviourResult,
  type PredictedBehaviour,
  type UnpredictedEntity,
} from "./behaviour";
import {
  behaviourDelta,
  formatPerHour,
  renderBehaviourFinding,
  renderProvenance,
  renderRate,
  validateBehaviourResult,
  type BehaviourDeltaReport,
} from "./behaviour-delta";

const TRAFFIC = "100 rps, p50";
const COMPLETE: BehaviourEdgeCoverage = { verdict: "complete" };
const PARTIAL: BehaviourEdgeCoverage = { verdict: "partial", unresolvedKinds: ["AWS::EC2::VPC"] };

function figure(overrides: Partial<PredictedBehaviour> = {}): PredictedBehaviour {
  return {
    at: { traffic: TRAFFIC },
    cost: predictedRate(0.272, "USD"),
    headroom: { cpu: 0.35, latency: 0.28 },
    errorRate: 0.0005,
    resilience: { failure: "one zone lost", verdict: "degrades" },
    provenance: { engine: "acme-sim", version: "1.4.2", tolerance: "±15%", basis: "modeled" },
    ...overrides,
  };
}

function report(
  entities: Record<string, PredictedBehaviour>,
  unpredicted: Record<string, UnpredictedEntity> = {},
  opts: { coverage?: BehaviourEdgeCoverage; traffic?: string; total?: { perHour: number; currency: string } } = {},
): BehaviourResult {
  const traffic = opts.traffic ?? TRAFFIC;
  const priced = Object.fromEntries(
    Object.entries(entities).map(([name, f]) => [name, { ...f, at: { traffic } }]),
  );
  return behaviourReport(
    { entityNames: [...Object.keys(entities), ...Object.keys(unpredicted)], traffic, edgeCoverage: opts.coverage ?? COMPLETE },
    { engine: "acme-sim", version: "1.4.2", ...(opts.total ? { total: predictedRate(opts.total.perHour, opts.total.currency) } : {}) },
    priced,
    unpredicted,
  );
}

const CTX = { env: "prod", op: "pr-behaviour" };

function delta(base: BehaviourResult, head: BehaviourResult) {
  return behaviourDelta({ label: "base", ref: "main", result: base }, { label: "head", ref: "feature", result: head });
}

/** The words the finding must never contain, as whole words. */
const FORBIDDEN = [/\bbills?\b/i, /\binvoices?\b/i, /\bcharges?\b/i, /\bcost you\b/i];

describe("validateBehaviourResult — a result held to the contract on arrival", () => {
  test("accepts a report the builder made, with the names it was asked", () => {
    const r = report({ db: figure() }, { role: { type: "AWS::IAM::Role", reason: "unsupported-kind" } });
    expect(validateBehaviourResult(r, ["db", "role"])).toBe(r);
  });

  test("accepts a refusal with a legal cause, a reason and a remedy", () => {
    const r = noBehaviourEngineRefusal("chant");
    expect(validateBehaviourResult(r, ["db"])).toBe(r);
  });

  test("refuses a bare envelope that is neither arm", () => {
    expect(() => validateBehaviourResult({ behaviour: "v1" }, [])).toThrow(/neither a report nor a refusal/);
  });

  test("refuses a report that gives no verdict for a name it was asked", () => {
    const r = report({ db: figure() });
    expect(() => validateBehaviourResult(r, ["db", "orders"])).toThrow(/no verdict at all for "orders"/);
  });

  test("refuses a figure for a name nobody asked about", () => {
    const r = report({ db: figure() });
    expect(() => validateBehaviourResult(r, [])).toThrow(/"db", which was not asked about/);
  });

  test("refuses a hand-built block that fails the block validator — a negative rate", () => {
    const r = report({ db: figure() }) as { entities: Record<string, PredictedBehaviour> };
    const tampered = { ...r, entities: { db: { ...r.entities.db, cost: predictedRate(-1, "USD") } } };
    expect(() => validateBehaviourResult(tampered, ["db"])).toThrow(/cost.perHour is negative/);
  });

  test("refuses a refusal with a cause outside the closed set", () => {
    const r = { behaviour: "v1", refusal: { cause: "no-money", reason: "x", remedy: "y" } };
    expect(() => validateBehaviourResult(r, [])).toThrow(/not a legal reason/);
  });
});

describe("behaviourDelta — a whole-run refusal on either side is no prediction", () => {
  test("a refused base side yields no-prediction carrying that side's refusal, and no rows", () => {
    const d = delta(noBehaviourEngineRefusal("chant"), report({ db: figure() }));
    expect(d.kind).toBe("no-prediction");
    if (d.kind !== "no-prediction") return;
    expect(d.base.refusal?.cause).toBe("no-engine");
    expect(d.head.refusal).toBeUndefined();
    expect("rows" in d).toBe(false);
  });

  test("a refused head side likewise, and both when both refuse", () => {
    const down = unreachableBehaviourEngineRefusal("chant", { value: "engine", source: "CHANT_BEHAVIOUR_ENGINE" }, "ECONNREFUSED");
    const d = delta(report({ db: figure() }), down);
    expect(d.kind).toBe("no-prediction");
    const both = delta(noBehaviourEngineRefusal("chant"), down);
    if (both.kind !== "no-prediction") throw new Error("expected no-prediction");
    expect(both.base.refusal?.cause).toBe("no-engine");
    expect(both.head.refusal?.cause).toBe("engine-unreachable");
  });

  test("the rendered finding says no prediction, carries renderBehaviourRefusal's text and the remedy, and no figure", () => {
    const d = delta(noBehaviourEngineRefusal("chant"), report({ db: figure() }));
    const body = renderBehaviourFinding(d, CTX);
    expect(body).toContain("no prediction");
    const refusal = noBehaviourEngineRefusal("chant").refusal;
    expect(body).toContain(renderBehaviourRefusal(refusal, { color: false }));
    expect(body).toContain(refusal.remedy);
    expect(body).not.toContain("/hour");
    expect(body).not.toContain("| Entity |");
  });
});

describe("behaviourDelta — a declined entity is a row, not an absent finding and not a zero", () => {
  const base = report({ db: figure(), orders: figure({ cost: predictedRate(0.004, "USD") }) });
  const head = report(
    { db: figure() },
    { orders: { type: "AWS::SQS::Queue", reason: "unsupported-kind", detail: "AWS::SQS::Queue is declared unmapped by the aws coverage rows" } },
  );

  test("the declined side is a row of kind declined carrying the reason, with no delta number", () => {
    const d = delta(base, head) as BehaviourDeltaReport;
    expect(d.kind).toBe("delta");
    const row = d.rows.find((r) => r.name === "orders")!;
    expect(row.kind).toBe("declined");
    expect(row.headDeclined?.reason).toBe("unsupported-kind");
    expect(row.base?.cost.perHour).toBe(0.004);
    expect(row.deltaPerHour).toBeUndefined();
    expect(row.type).toBe("AWS::SQS::Queue");
  });

  test("the sum of comparable deltas excludes the declined entity", () => {
    const d = delta(base, head) as BehaviourDeltaReport;
    expect(d.sums).toEqual([{ currency: "USD", perHour: 0, pairs: 1 }]);
  });

  test("an estate that gained an unmapped kind is not a cost change", () => {
    const grown = report(
      { db: figure() },
      { role: { type: "AWS::IAM::Role", reason: "unsupported-kind", detail: "a role is a grant" } },
    );
    const d = delta(report({ db: figure() }), grown) as BehaviourDeltaReport;
    expect(d.rows.find((r) => r.name === "role")?.kind).toBe("declined");
    expect(d.sums).toEqual([{ currency: "USD", perHour: 0, pairs: 1 }]);
  });

  test("renders the declined row in the table and its detail under it", () => {
    const body = renderBehaviourFinding(delta(base, head), CTX);
    expect(body).toMatch(/\| orders \| AWS::SQS::Queue \| 0\.004 USD\/hour \| declined: unsupported-kind \| no delta \(declined\) \|/);
    expect(body).toContain("### Declined entities");
    expect(body).toContain("`orders` on head: `unsupported-kind` — AWS::SQS::Queue is declared unmapped");
  });
});

describe("behaviourDelta — a mismatched pair is marked, never subtracted", () => {
  test("mixed-basis: the row is marked with the label and carries no delta number", () => {
    const base = report({ db: figure() });
    const head = report({
      db: figure({ provenance: { engine: "acme-sim", version: "1.4.2", tolerance: "±15%", basis: "validated" } }),
    });
    const d = delta(base, head) as BehaviourDeltaReport;
    const row = d.rows[0];
    expect(row.kind).toBe("marked");
    expect(row.mismatches).toEqual(["mixed-basis"]);
    expect(row.deltaPerHour).toBeUndefined();
    expect(d.sums).toEqual([]);
    const body = renderBehaviourFinding(d, CTX);
    expect(body).toMatch(/\| db \|  \| 0\.272 USD\/hour \| 0\.272 USD\/hour \| marked: mixed-basis \|/);
    expect(body).toContain("No pair is comparable, so no delta is summed.");
    expect(body).toContain("base: acme-sim 1.4.2 · ±15% · modeled; head: acme-sim 1.4.2 · ±15% · validated");
  });

  test("every mismatched axis is named, in the contract's display order", () => {
    const base = report({ db: figure() });
    const head = report(
      {
        db: figure({
          cost: predictedRate(0.3, "EUR"),
          resilience: { failure: "a region lost", verdict: "fails" },
          provenance: { engine: "other-sim", version: "9", tolerance: "±50%", basis: "validated" },
        }),
      },
      {},
      { traffic: "1000 rps, p99" },
    );
    const d = delta(base, head) as BehaviourDeltaReport;
    expect(d.rows[0].mismatches).toEqual(["mixed-engine", "mixed-level", "mixed-currency", "mixed-basis", "mixed-failure"]);
    const body = renderBehaviourFinding(d, CTX);
    expect(body).toContain("marked: mixed-engine, mixed-level, mixed-currency, mixed-basis, mixed-failure");
    expect(body).toContain("predicted at different traffic levels");
  });

  test("a comparable pair is a plain difference, summed per currency", () => {
    const base = report({ db: figure(), eu: figure({ cost: predictedRate(1, "EUR") }) });
    const head = report({ db: figure({ cost: predictedRate(0.4, "USD") }), eu: figure({ cost: predictedRate(0.5, "EUR") }) });
    const d = delta(base, head) as BehaviourDeltaReport;
    expect(d.rows.map((r) => [r.name, r.kind, r.deltaPerHour])).toEqual([
      ["db", "comparable", 0.4 - 0.272],
      ["eu", "comparable", -0.5],
    ]);
    expect(d.sums).toEqual([
      { currency: "EUR", perHour: -0.5, pairs: 1 },
      { currency: "USD", perHour: 0.4 - 0.272, pairs: 1 },
    ]);
    const body = renderBehaviourFinding(d, CTX);
    expect(body).toContain("| +0.128 USD/hour |");
    expect(body).toContain("| -0.5 EUR/hour |");
    expect(body).toContain("chant's own arithmetic");
  });

  test("an entity on one side only is added or removed, with no delta", () => {
    const d = delta(report({ db: figure(), old: figure() }), report({ db: figure(), fresh: figure() })) as BehaviourDeltaReport;
    expect(d.rows.find((r) => r.name === "old")?.kind).toBe("only-base");
    expect(d.rows.find((r) => r.name === "fresh")?.kind).toBe("only-head");
    const body = renderBehaviourFinding(d, CTX);
    expect(body).toMatch(/\| old \|.*\| removed \|/);
    expect(body).toMatch(/\| fresh \|.*\| added \|/);
  });
});

describe("renderBehaviourFinding — every figure carries its provenance, and a rate is a rate", () => {
  test("a rate renders per hour, and never as an amount", () => {
    expect(renderRate(predictedRate(0.272, "USD"))).toBe("0.272 USD/hour");
    expect(renderRate(predictedRate(3, "EUR"))).toBe("3 EUR/hour");
    expect(formatPerHour(0.00230000001)).toBe("0.0023");
    expect(formatPerHour(12.5)).toBe("12.5");
  });

  test("provenance is the four fields together", () => {
    expect(renderProvenance(figure().provenance)).toBe("acme-sim 1.4.2 · ±15% · modeled");
  });

  test("each row carries the engine, version, tolerance and basis of its figures", () => {
    const d = delta(report({ db: figure(), web: figure({ cost: predictedRate(0.04, "USD") }) }), report({ db: figure(), web: figure({ cost: predictedRate(0.05, "USD") }) }));
    const body = renderBehaviourFinding(d, CTX);
    const rows = body.split("\n").filter((l) => /^\| (db|web) \|/.test(l));
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row).toContain("acme-sim 1.4.2 · ±15% · modeled");
  });

  test("names the Op and the env in the heading, and the traffic level", () => {
    const body = renderBehaviourFinding(delta(report({ db: figure() }), report({ db: figure() })), CTX);
    expect(body).toContain("## Predicted behaviour for `prod` at `100 rps, p50` (Op `pr-behaviour`)");
    expect(body).toContain("A prediction, not a measurement.");
  });

  test("never uses the words that would make a prediction read as money owed", () => {
    const withEverything = delta(
      report({ db: figure(), orders: figure({ cost: predictedRate(0.004, "USD") }), old: figure() }, {}, { total: { perHour: 0.3, currency: "USD" } }),
      report(
        { db: figure({ provenance: { engine: "acme-sim", version: "1.4.2", tolerance: "±15%", basis: "validated" }, rightSize: { suggestion: "db.t4g.micro", reason: "headroom" } }), fresh: figure() },
        { orders: { type: "AWS::SQS::Queue", reason: "unsupported-kind", detail: "declared unmapped" } },
        { coverage: PARTIAL },
      ),
    );
    for (const body of [
      renderBehaviourFinding(withEverything, CTX),
      renderBehaviourFinding(delta(noBehaviourEngineRefusal("chant"), report({ db: figure() })), CTX),
    ]) {
      for (const word of FORBIDDEN) expect(body).not.toMatch(word);
    }
  });

  test("shows the engine's own estate total per side and never differences the two", () => {
    const d = delta(
      report({ db: figure() }, {}, { total: { perHour: 0.3, currency: "USD" } }),
      report({ db: figure() }, {}, { total: { perHour: 0.9, currency: "USD" } }),
    );
    const body = renderBehaviourFinding(d, CTX);
    expect(body).toContain("| base | main | acme-sim 1.4.2 | 100 rps, p50 | complete | 0.3 USD/hour |");
    expect(body).toContain("| head | feature | acme-sim 1.4.2 | 100 rps, p50 | complete | 0.9 USD/hour |");
    expect(body).not.toContain("0.6 USD/hour");
  });
});

describe("renderBehaviourFinding — resilience across unequal edge coverage", () => {
  test("both sides complete: the verdicts are compared on one row", () => {
    const d = delta(report({ db: figure() }), report({ db: figure({ resilience: { failure: "one zone lost", verdict: "fails" } }) })) as BehaviourDeltaReport;
    expect(d.resilienceComparable).toBe(true);
    const body = renderBehaviourFinding(d, CTX);
    expect(body).toContain("| degrades → fails (one zone lost) |");
    expect(body).not.toContain("not compared");
  });

  test("either side partial or unknown: coverage is shown for both and the verdicts are shown per side, not compared", () => {
    const d = delta(
      report({ db: figure() }, {}, { coverage: PARTIAL }),
      report({ db: figure({ resilience: { failure: "one zone lost", verdict: "fails" } }) }),
    ) as BehaviourDeltaReport;
    expect(d.resilienceComparable).toBe(false);
    const body = renderBehaviourFinding(d, CTX);
    expect(body).toContain("| partial (unresolved kinds: AWS::EC2::VPC) |");
    expect(body).toContain("| complete |");
    expect(body).toContain("Resilience verdicts are shown per side and **not compared**");
    expect(body).toContain("| base degrades (one zone lost); head fails (one zone lost) |");
    expect(body).not.toContain("degrades → fails");

    const unknown = delta(report({ db: figure() }), report({ db: figure() }, {}, { coverage: { verdict: "unknown" } })) as BehaviourDeltaReport;
    expect(unknown.resilienceComparable).toBe(false);
  });
});
