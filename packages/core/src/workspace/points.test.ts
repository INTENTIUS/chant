/**
 * Decision points (ws-058, #2738): the declaration schema, the rules checked
 * in code, and the decider chain with a stub model decider.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { REPO, validSchema } from "./__fixtures__/contract-repo";
import schema from "./decision-points.schema.json";
import {
  answerId,
  candidates,
  inputsHash,
  observe,
  parsePoints,
  POINT_INPUT_OUTPUTS,
  pointVersion,
  PointsError,
  runChain,
  type ModelAsk,
  type Point,
  type WireAnswer,
} from "./points";

/**
 * chud's points, as template/delivery/decisions/points.yaml declares them at
 * jhgaylor/chud@43afcf1, as JSON.
 */
const CHUD = {
  points: {
    "slice-tier": {
      title: "Which builder tier builds this contract",
      question: {
        type: "choice",
        instructions:
          "Pick the smallest builder tier that can build this contract. The state is how much the contract holds and whether that fits each tier's sizing limits (lint.rules in chant.config.ts).",
        criteria: {
          small: "A haiku-class builder. The contract fits the small limits.",
          medium: "A mid-size builder. The contract fits the medium limits.",
          large: "The largest builder. The contract is bigger than the medium limits.",
        },
      },
      inputs: {
        criteria: "acceptance criteria in the contract",
        files: "distinct paths the contract names",
        words: "words in the body outside headings",
        fits_small: "whether it is within the small tier's limits",
        fits_medium: "whether it is within the medium tier's limits",
      },
      deciders: [
        {
          kind: "table",
          rows: [
            { when: { fits_small: true }, answer: "small" },
            { when: { fits_medium: true }, answer: "medium" },
          ],
        },
        { kind: "model", backend: "systemone", model: "bosun-v3.1-1.7b", threshold: 0.8 },
        { kind: "quorum", count: 1 },
      ],
    },
    "ship-skip": {
      title: "May this release skip the human gate",
      question: {
        type: "boolean",
        instructions: "May this release pass the ship gate without a person approving it? The state is what the release plan would change.",
        criteria: {
          true: "An agent may pass the gate for this release (only in enforce mode).",
          false: "A person approves the release at the gate.",
        },
      },
      inputs: {
        first_release: "nothing has shipped yet",
        new_migrations: "migrations that would fire",
        files_changed: "files changed since the serving release",
        app_changed: "whether any file under the app directory changed",
        contracts_changed: "whether any file under contracts/ changed",
        units: "units of work the release ships",
      },
      deciders: [
        { kind: "table", rows: [{ when: {}, answer: false, note: "Never, until someone adds a row above this one that says when." }] },
        { kind: "quorum", count: 1 },
      ],
    },
  },
};

/** chud's points with each input named as a read-contract output: the slice tier reads a work item, the ship gate a release. */
function renamed(): typeof CHUD {
  const copy = JSON.parse(JSON.stringify(CHUD)) as typeof CHUD;
  const prefix: Record<string, string> = { "slice-tier": "work-item", "ship-skip": "release" };
  for (const [name, point] of Object.entries(copy.points) as [string, { inputs: Record<string, string>; deciders: { rows?: { when: Record<string, unknown> }[] }[] }][]) {
    const to = (k: string) => `${prefix[name]}.${k}`;
    point.inputs = Object.fromEntries(Object.entries(point.inputs).map(([k, v]) => [to(k), v]));
    for (const d of point.deciders) for (const r of d.rows ?? []) r.when = Object.fromEntries(Object.entries(r.when).map(([k, v]) => [to(k), v]));
  }
  return copy;
}

const text = (v: unknown) => JSON.stringify(v);

function problems(v: unknown): { field: string | null; message: string }[] {
  try {
    parsePoints(text(v), "points.json");
    return [];
  } catch (err) {
    if (err instanceof PointsError) return err.problems;
    throw err;
  }
}

describe("the decision points schema (#2738)", () => {
  test("is a valid draft 2020-12 document at a v1 id", () => {
    expect(validSchema(schema)).toBe(true);
    expect(schema.$id).toBe("https://intentius.io/chant/schemas/workspace/decision-points/v1/decision-points.schema.json");
  });

  test("each input output is a $defs entry of a read-contract output schema", () => {
    for (const [name, o] of Object.entries(POINT_INPUT_OUTPUTS)) {
      const s = JSON.parse(readFileSync(join(import.meta.dirname, `${o.schema}.schema.json`), "utf-8")) as { $defs: Record<string, unknown> };
      expect(s.$defs[o.def], `${name}: ${o.schema}.schema.json has no $defs.${o.def}`).toBeDefined();
    }
  });

  test("chud's slice-tier and ship-skip validate unchanged, apart from the input names", () => {
    // As chud declares them, only the input names are refused: each names no read-contract output.
    const found = problems(CHUD);
    expect(found.length).toBeGreaterThan(0);
    for (const p of found) expect(p.message).toMatch(/is not a read-contract output|is not one of this point's inputs/);
    expect(found.filter((p) => p.message.includes("read-contract output")).map((p) => p.field)).toEqual([
      ...Object.keys(CHUD.points["slice-tier"].inputs).map((k) => `points.slice-tier.inputs.${k}`),
      ...Object.keys(CHUD.points["ship-skip"].inputs).map((k) => `points.ship-skip.inputs.${k}`),
    ]);
    // With the inputs renamed, nothing else changes and both validate.
    const points = parsePoints(text(renamed()), "points.json");
    expect(Object.keys(points)).toEqual(["slice-tier", "ship-skip"]);
    expect(points["ship-skip"].question.type).toBe("noul");
    expect(candidates(points["ship-skip"].question)).toEqual([true, false]);
    expect(candidates(points["slice-tier"].question)).toEqual(["small", "medium", "large"]);
  });

  test("the reference workspace's points validate", () => {
    const points = parsePoints(readFileSync(join(REPO, "reference-workspace", "decisions", "points.json"), "utf-8"), "decisions/points.json");
    expect(Object.keys(points)).toEqual(["slice-tier", "ship-skip", "finding-triage", "needs-a-decision"]);
  });

  test("a point whose chain does not end in a quorum is refused", () => {
    const v = renamed();
    v.points["slice-tier"].deciders.pop();
    expect(problems(v)).toEqual([{ field: "points.slice-tier.deciders", message: "must end in a quorum: when no table row or model answers, people do" }]);
    const w = renamed();
    w.points["ship-skip"].deciders.reverse();
    expect(problems(w).map((p) => p.field)).toEqual(["points.ship-skip.deciders.0", "points.ship-skip.deciders"]);
  });

  test("a point with an unknown input is refused, and so is a row testing an undeclared one", () => {
    const v = renamed() as unknown as { points: Record<string, { inputs: Record<string, string>; deciders: { rows?: { when: Record<string, unknown> }[] }[] }> };
    v.points["slice-tier"].inputs["contract.size"] = "chud's contract, which the read contract has no output for";
    expect(problems(v)).toEqual([
      {
        field: "points.slice-tier.inputs.contract.size",
        message: `names "contract", which is not a read-contract output; an input is one of ${Object.keys(POINT_INPUT_OUTPUTS).join(", ")}, optionally with dotted field names`,
      },
    ]);
    const w = renamed() as unknown as typeof v;
    w.points["slice-tier"].deciders[0].rows![0].when = { "work-item.tier": "small" };
    expect(problems(w)).toEqual([{ field: "points.slice-tier.deciders.0.rows.0.when.work-item.tier", message: expect.stringContaining("is not one of this point's inputs") }]);
  });

  test("the schema and the code refuse the rest of what chud refused, and an alias model id", () => {
    const cases: [(p: Record<string, unknown>) => void, RegExp][] = [
      [(p) => ((p.deciders as Record<string, unknown>[])[1].model = "jev-latest"), /is an alias/],
      [(p) => ((p.deciders as Record<string, unknown>[])[1].count = 2), /is only for a quorum decider/],
      [(p) => (((p.deciders as { rows: { answer: unknown }[] }[])[0].rows[0].answer = "tiny")), /must be one of "small", "medium", "large"/],
      [(p) => delete (p.deciders as Record<string, unknown>[])[1].threshold, /is missing "threshold"/],
      [(p) => (p.question = { type: "score", instructions: "x", criteria: ["one"] }), /must NOT have fewer than 2 items/],
      [(p) => (p.extra = true), /unknown field "extra"/],
      [(p) => delete p.inputs, /is missing "inputs"/],
    ];
    for (const [edit, message] of cases) {
      const v = renamed() as unknown as { points: Record<string, Record<string, unknown>> };
      edit(v.points["slice-tier"]);
      expect(problems(v).map((p) => p.message).join("\n")).toMatch(message);
    }
    expect(problems("not json" as unknown)).toHaveLength(1);
  });
});

const POINTS = parsePoints(text(renamed()), "points.json");
const SLICE = POINTS["slice-tier"];
const NOUL: Point = {
  title: "Does this change need a decision",
  question: { type: "noul", instructions: "Does it?", criteria: { true: "yes", false: "no" } },
  inputs: { commit: "the commit" },
  deciders: [
    { kind: "model", backend: "systemone", model: "jev-1.13.0", threshold: 0.8 },
    { kind: "quorum", count: 1 },
  ],
};

/** A stub model decider: the pinned model answers with `answer`. */
const stub =
  (answer: WireAnswer, model?: string): ModelAsk =>
  async (req) => ({ model: model ?? req.model, answer });

const big = { "work-item.fits_small": false, "work-item.fits_medium": false };

describe("the decider chain (#2739)", () => {
  test("a table row answers", async () => {
    expect(await runChain("slice-tier", SLICE, { "work-item.fits_small": true })).toMatchObject({ status: "answered", answer: "small", decider: { kind: "table", row: 0 } });
  });

  test("a model at or above its threshold proposes, with its values", async () => {
    const r = await runChain("slice-tier", SLICE, big, stub({ type: "choice", choice: "large", probabilities: { small: 0.02, medium: 0.1, large: 0.88 }, confidence: 0.8 }));
    expect(r).toEqual({
      status: "proposed",
      answer: "large",
      decider: { kind: "model", backend: "systemone", model: "bosun-v3.1-1.7b" },
      probabilities: { small: 0.02, medium: 0.1, large: 0.88 },
      confidence: 0.8,
      threshold: 0.8,
      escalations: [{ kind: "table", reason: "no row matches these inputs" }],
    });
  });

  test("below its threshold the question escalates to the quorum, with the model's answer", async () => {
    const r = await runChain("slice-tier", SLICE, big, stub({ type: "choice", choice: "medium", probabilities: { small: 0.2, medium: 0.5, large: 0.3 }, confidence: 0.25 }));
    expect(r.status).toBe("escalated");
    expect(r.decider).toEqual({ kind: "quorum", count: 1 });
    expect(r.escalations[1]).toMatchObject({ kind: "model", answer: "medium", confidence: 0.25, threshold: 0.8, reason: "not observed: confidence 0.25 is below the threshold 0.8" });
  });

  test("without a backend, or with an unpinned model answering, the model is not asked or not observed", async () => {
    expect((await runChain("slice-tier", SLICE, big)).escalations[1].reason).toBe("not asked: no model backend was given to this ask");
    const r = await runChain("slice-tier", SLICE, big, stub({ type: "choice", choice: "large", confidence: 0.99 }, "bosun-latest"));
    expect(r.status).toBe("escalated");
    expect(r.escalations[1].reason).toBe("not observed: bosun-latest answered, and the point pins bosun-v3.1-1.7b");
  });

  test("an unreachable backend escalates, or fails when the point fails closed", async () => {
    const down: ModelAsk = async () => {
      throw new Error("connect ECONNREFUSED");
    };
    expect((await runChain("n", NOUL, {}, down)).escalations[0].reason).toBe("not observed: systemone could not answer: connect ECONNREFUSED");
    const closed: Point = { ...NOUL, deciders: [{ ...(NOUL.deciders[0] as Extract<Point["deciders"][number], { kind: "model" }>), unreachable: "fail" }, NOUL.deciders[1]] };
    await expect(runChain("n", closed, {}, down)).rejects.toThrow(/fails closed/);
  });

  test("a noul reads its probability both ways", () => {
    expect(observe(NOUL.question, { type: "noul", noul: 0.9 }, 0.8)).toMatchObject({ observed: true, answer: true, confidence: 0.9 });
    expect(observe(NOUL.question, { type: "noul", noul: 0.1 }, 0.8)).toMatchObject({ observed: true, answer: false, confidence: 0.9 });
    expect(observe(NOUL.question, { type: "noul", noul: 0.4 }, 0.8)).toMatchObject({ observed: false, answer: false, confidence: 0.6 });
    expect(observe(NOUL.question, { type: "unsupported" }, 0.8)).toMatchObject({ observed: false });
  });

  test("the version and inputs hash are stable over key order, and name the answer", () => {
    const a = inputsHash("slice-tier", pointVersion(SLICE), { x: 1, y: [1, { b: 2, a: 1 }] });
    const b = inputsHash("slice-tier", pointVersion(SLICE), { y: [1, { a: 1, b: 2 }], x: 1 });
    expect(a).toBe(b);
    expect(answerId("slice-tier", a)).toBe(`slice-tier-${a.slice(0, 12)}`);
    expect(inputsHash("slice-tier", pointVersion({ ...SLICE, title: "changed" }), { x: 1, y: [1, { b: 2, a: 1 }] })).not.toBe(a);
  });
});
