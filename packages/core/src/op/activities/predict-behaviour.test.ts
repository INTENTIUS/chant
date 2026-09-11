/**
 * The behaviour activities (#2358): the marker, the base-ref resolution, the
 * declared path's coverage claim, and the finding activity driven end to end
 * against fixtures with its poster stubbed.
 */

import { describe, expect, test, vi } from "vitest";
import {
  behaviourReport,
  noBehaviourEngineRefusal,
  predictedRate,
  validateEdgeCoverage,
  type BehaviourResult,
  type PredictedBehaviour,
} from "../../behaviour";
import { commentMarker, issueMarker, type ReconcilePrArgs, type ReconcileResult } from "./reconcile";
import {
  ambiguousPredictorMessage,
  baseRefFrom,
  behaviourFindingMarker,
  createBehaviourFinding,
  declaredEdgeCoverage,
  headRefFrom,
  noBaseRefMessage,
  noPredictingLexiconMessage,
  type BaseCheckout,
} from "./predict-behaviour";

const TRAFFIC = "1000 rps, p99";

function figure(perHour: number, basis: "modeled" | "validated" = "modeled"): PredictedBehaviour {
  return {
    at: { traffic: TRAFFIC },
    cost: predictedRate(perHour, "USD"),
    headroom: { cpu: 0.5 },
    errorRate: 0.001,
    resilience: { failure: "one zone lost", verdict: "survives" },
    provenance: { engine: "acme-sim", version: "1.4.2", tolerance: "±15%", basis },
  };
}

function report(entities: Record<string, PredictedBehaviour>, unpredicted: Record<string, { type?: string; reason: "unsupported-kind"; detail?: string }> = {}): BehaviourResult {
  return behaviourReport(
    { entityNames: [...Object.keys(entities), ...Object.keys(unpredicted)], traffic: TRAFFIC, edgeCoverage: { verdict: "partial", unresolvedKinds: ["AWS::EC2::VPC"] } },
    { engine: "acme-sim", version: "1.4.2" },
    entities,
    unpredicted,
  );
}

describe("behaviourFindingMarker — names the Op and the env (#2319)", () => {
  test("keys on both, slugified, and is distinct from both reconcilePr markers for the same env", () => {
    expect(behaviourFindingMarker("pr-behaviour", "prod")).toBe("<!-- chant-behaviour:pr-behaviour/prod -->");
    expect(behaviourFindingMarker("pr-behaviour", "prod")).not.toBe(commentMarker("prod"));
    expect(behaviourFindingMarker("pr-behaviour", "prod")).not.toBe(issueMarker("pr-behaviour", "prod"));
    expect(behaviourFindingMarker("a", "prod")).not.toBe(behaviourFindingMarker("b", "prod"));
  });

  test("slugifies the way the other markers do, so nothing it sits next to can be escaped out of", () => {
    const marker = behaviourFindingMarker('op" or true', "us-east/1");
    expect(marker).toBe("<!-- chant-behaviour:op-or-true/us-east-1 -->");
    expect(marker).not.toMatch(/["'\\]/);
  });
});

describe("baseRefFrom / headRefFrom — read off the run's own event", () => {
  test("GITHUB_BASE_REF on GitHub and Forgejo, CI_MERGE_REQUEST_TARGET_BRANCH_NAME on GitLab, an explicit base first", () => {
    expect(baseRefFrom({ GITHUB_BASE_REF: "main" })).toBe("main");
    expect(baseRefFrom({ CI_MERGE_REQUEST_TARGET_BRANCH_NAME: "develop" })).toBe("develop");
    expect(baseRefFrom({ GITHUB_BASE_REF: "main" }, "release")).toBe("release");
    expect(baseRefFrom({ GITHUB_BASE_REF: "  " })).toBeUndefined();
    expect(baseRefFrom({})).toBeUndefined();
  });

  test("the head side is the source branch when the run names one, else the short commit, else `head`", () => {
    expect(headRefFrom({ GITHUB_HEAD_REF: "feature/x" }, "abc1234")).toBe("feature/x");
    expect(headRefFrom({ CI_MERGE_REQUEST_SOURCE_BRANCH_NAME: "mr-branch" })).toBe("mr-branch");
    expect(headRefFrom({}, "abc1234")).toBe("abc1234");
    expect(headRefFrom({})).toBe("head");
  });

  test("the refusal names both variables and the explicit arg", () => {
    expect(noBaseRefMessage()).toMatch(/GITHUB_BASE_REF.*CI_MERGE_REQUEST_TARGET_BRANCH_NAME.*`base`/s);
  });
});

describe("declaredEdgeCoverage — never complete on the declared path", () => {
  test("unknown: references are exhaustive, containment is absent, and the contract cannot name that gap", () => {
    const coverage = declaredEdgeCoverage();
    expect(coverage.verdict).toBe("unknown");
    expect(coverage.unresolvedKinds).toBeUndefined();
    expect(coverage.dangling).toBeUndefined();
    // And it satisfies the contract's own validator as it stands.
    expect(() => validateEdgeCoverage(coverage)).not.toThrow();
  });
});

describe("the refusals for a project that cannot predict", () => {
  test("no predicting lexicon names the configured ones and what to add", () => {
    expect(noPredictingLexiconMessage(["aws", "k8s"])).toMatch(/\(aws, k8s\).*augur.*CHANT_BEHAVIOUR_ENGINE/s);
    expect(noPredictingLexiconMessage([])).toContain("(none)");
  });

  test("two predicting lexicons is refused rather than merged", () => {
    expect(ambiguousPredictorMessage(["augur", "other"])).toMatch(/2 configured lexicons.*\(augur, other\)/);
  });
});

/** A finding activity over fixtures: predict by project path, check out nothing, post into `posted`. */
function harness(opts: {
  head: BehaviourResult;
  base: BehaviourResult;
  env?: Record<string, string | undefined>;
  baseThrows?: Error;
}) {
  const calls: string[] = [];
  const posted: ReconcilePrArgs[] = [];
  const checkout: BaseCheckout = {
    projectPath: "/tmp/base-checkout",
    cleanup: async () => {
      calls.push("cleanup");
    },
  };
  const run = createBehaviourFinding({
    env: opts.env ?? { GITHUB_BASE_REF: "main", GITHUB_HEAD_REF: "feature" },
    shortSha: async () => "abc1234",
    checkout: async (base) => {
      calls.push(`checkout:${base}`);
      return checkout;
    },
    predict: async (projectPath) => {
      calls.push(`predict:${projectPath === checkout.projectPath ? "base" : "head"}`);
      if (projectPath === checkout.projectPath) {
        if (opts.baseThrows) throw opts.baseThrows;
        return opts.base;
      }
      return opts.head;
    },
    post: async (args): Promise<ReconcileResult> => {
      posted.push(args);
      return {
        mode: "comment",
        summary: args.body ?? "",
        entries: [],
        commentUrl: "https://forge.example/pr/5#c1",
        pullRequest: "acme/infra#5",
      };
    },
  });
  return { run, calls, posted };
}

describe("behaviourFinding — predicts both sides, differences them, and posts through reconcilePr", () => {
  test("head is predicted first, the base checkout is cleaned up, and the delta is posted with the Op-keyed marker", async () => {
    const { run, calls, posted } = harness({
      base: report({ db: figure(0.272), orders: figure(0.004) }),
      head: report({ db: figure(0.4) }, { orders: { type: "AWS::SQS::Queue", reason: "unsupported-kind", detail: "declared unmapped" } }),
    });
    const result = await run({ environment: "prod", traffic: TRAFFIC, op: "pr-behaviour" });

    expect(calls).toEqual(["predict:head", "checkout:main", "predict:base", "cleanup"]);
    expect(result.mode).toBe("comment");
    expect(result.base).toBe("main");
    expect(result.head).toBe("feature");
    expect(result.refused).toBe(false);
    expect(result.commentUrl).toBe("https://forge.example/pr/5#c1");
    expect(result.pullRequest).toBe("acme/infra#5");

    expect(posted).toHaveLength(1);
    expect(posted[0].mode).toBe("comment");
    expect(posted[0].env).toBe("prod");
    expect(posted[0].op).toBe("pr-behaviour");
    expect(posted[0].marker).toBe(behaviourFindingMarker("pr-behaviour", "prod"));
    expect(posted[0].body).toBe(result.summary);
    // The delta rules survive the trip: a declined entity is a row, not a zero.
    expect(result.summary).toMatch(/\| orders \| AWS::SQS::Queue \| 0\.004 USD\/hour \| declined: unsupported-kind \|/);
    expect(result.summary).toContain("| +0.128 USD/hour |");
    expect(result.finding.kind).toBe("delta");
  });

  test("a mixed-basis pair reaches the comment marked, not subtracted", async () => {
    const { run } = harness({
      base: report({ db: figure(0.272, "modeled") }),
      head: report({ db: figure(0.272, "validated") }),
    });
    const result = await run({ environment: "prod", traffic: TRAFFIC, op: "pr-behaviour" });
    expect(result.summary).toContain("| marked: mixed-basis |");
    expect(result.summary).not.toContain("| 0 USD/hour |");
  });

  test("report mode posts nothing and returns the body", async () => {
    const { run, posted } = harness({ base: report({ db: figure(0.1) }), head: report({ db: figure(0.1) }) });
    const result = await run({ environment: "prod", traffic: TRAFFIC, op: "pr-behaviour", mode: "report" });
    expect(posted).toHaveLength(0);
    expect(result.mode).toBe("report");
    expect(result.commentUrl).toBeUndefined();
    expect(result.summary).toContain("## Predicted behaviour for `prod`");
  });

  test("a refusal on the base side posts a finding that says no prediction, and flags the run", async () => {
    const { run, posted } = harness({ base: noBehaviourEngineRefusal("augur"), head: report({ db: figure(0.1) }) });
    const result = await run({ environment: "prod", traffic: TRAFFIC, op: "pr-behaviour" });
    expect(result.refused).toBe(true);
    expect(result.finding.kind).toBe("no-prediction");
    expect(posted[0].body).toContain("no prediction");
    expect(posted[0].body).toContain("Set CHANT_BEHAVIOUR_ENGINE to the engine's address.");
    expect(posted[0].body).not.toContain("/hour");
  });

  test("the base checkout is removed even when its prediction throws", async () => {
    const { run, calls } = harness({
      base: report({ db: figure(0.1) }),
      head: report({ db: figure(0.1) }),
      baseThrows: new Error("the base did not build"),
    });
    await expect(run({ environment: "prod", traffic: TRAFFIC, op: "pr-behaviour" })).rejects.toThrow(/did not build/);
    expect(calls).toContain("cleanup");
  });

  test("refuses by name with no base branch to predict against, before predicting anything", async () => {
    const { run, calls } = harness({ base: report({}), head: report({}), env: {} });
    await expect(run({ environment: "prod", traffic: TRAFFIC, op: "pr-behaviour" })).rejects.toThrow(/GITHUB_BASE_REF/);
    expect(calls).toEqual([]);
  });

  test("an explicit base wins over the run's own, for a local `chant run`", async () => {
    const { run, calls } = harness({ base: report({}), head: report({}), env: { GITHUB_BASE_REF: "main" } });
    await run({ environment: "prod", traffic: TRAFFIC, op: "pr-behaviour", base: "release", mode: "report" });
    expect(calls).toContain("checkout:release");
  });

  test("refuses a step with no `op`, which is what keys the marker", async () => {
    const { run } = harness({ base: report({}), head: report({}) });
    await expect(run({ environment: "prod", traffic: TRAFFIC, op: " " })).rejects.toThrow(/needs `op`/);
  });

  test("the posted title never reads as a bill", async () => {
    const { run, posted } = harness({ base: report({}), head: report({}) });
    await run({ environment: "prod", traffic: TRAFFIC, op: "pr-behaviour" });
    expect(posted[0].title).toBe("Predicted behaviour for prod at 1000 rps, p99");
  });
});

describe("the activity registry carries both activities", () => {
  test("predictBehaviour and behaviourFinding resolve by name with nothing but chant installed", async () => {
    const { loadActivities } = await import("../activity-registry");
    const activities = await loadActivities([]);
    expect(activities.has("predictBehaviour")).toBe(true);
    expect(activities.has("behaviourFinding")).toBe(true);
    // The builder is not an activity; the registry collects every exported
    // function, so it stays off the index on purpose.
    expect(activities.has("createBehaviourFinding")).toBe(false);
    vi.restoreAllMocks();
  });
});
