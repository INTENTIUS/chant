/**
 * The live path, end to end (#2360): the two reads, the screen, the engine,
 * and the delta against the declared path.
 *
 * The estate is the recorded one `./request.test.ts` and
 * `../describe-resources.live.test.ts` use — `../__fixtures__/live-estate/`
 * parsed as a build parses it, and the two documents choudoufu v0.15.0
 * recorded from it against its pinned floci image. The activities are
 * injected, so nothing here runs choudoufu and nothing reaches an account.
 *
 * ## The engine
 *
 * `deps.predict` is augur's `predictBehaviour` in production. Here it is
 * {@link tariff}, which prices a node per hour by its provider type and
 * nothing else. That is a poor cost model and a good instrument: it makes an
 * estate's total a plain sum over the entities that side of the path sent, so
 * a difference between the two totals is a difference in **which entities were
 * sent** and cannot be anything else. Which entities each side sends is the
 * whole of what this issue changed.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import {
  behaviourReport,
  isBehaviourRefusalReport,
  predictedRate,
  type BehaviourReport,
  type BehaviourResult,
  type PredictBehaviourOptions,
  type PredictedBehaviour,
  type UnpredictedEntity,
} from "@intentius/chant/behaviour";
import type { Declarable } from "@intentius/chant/declarable";
import type { TerraformReadDeps } from "../describe-resources";
import { renderTerraformRoots } from "../hcl/roots";
import { liveRootsOf, predictTerraformBehaviour, TERRAFORM } from "./predict";
import type { TerraformBehaviourEntity } from "./request";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "..", "__fixtures__");
const PLAN: unknown = JSON.parse(readFileSync(join(fixtures, "live-plan.json"), "utf-8"));
const LS: unknown = JSON.parse(readFileSync(join(fixtures, "live-ls.json"), "utf-8"));
const ROOT = "estate";
const ESTATE = "stateless-e2e-block";

const key = (address: string): string => `${ROOT}/${address}`;

let entities: Map<string, TerraformBehaviourEntity>;
let entityNames: string[];

beforeAll(async () => {
  const rendered = await renderTerraformRoots({
    projectRoot: fixtures,
    roots: { [ROOT]: { dir: "./live-estate" } },
    binary: "choudoufu",
  });
  entities = new Map();
  for (const [name, entity] of rendered.entities) {
    const e = entity as Declarable & { props: Record<string, unknown>; references?: readonly never[] };
    entities.set(name, {
      entityType: e.entityType,
      props: e.props,
      ...(e.references ? { references: e.references } : {}),
    });
  }
  entityNames = [...entities.keys()].sort();
});

/* ── the activities ──────────────────────────────────────────────────────── */

/** A stock activity that must never be reached: a live root has no state file to show. */
const neverStock = (() => {
  throw new Error("terraform show was run on a live root");
}) as never;

interface Call {
  activity: "liveLs" | "livePlan";
  root: string;
}

function deps(overrides?: Partial<TerraformReadDeps>): { deps: TerraformReadDeps; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    deps: {
      init: neverStock,
      show: neverStock,
      livePlan: (async (options: { root: string }) => {
        calls.push({ activity: "livePlan", root: options.root });
        return { json: PLAN, estate: ESTATE, dir: fixtures, drift: true, text: "" };
      }) as unknown as TerraformReadDeps["livePlan"],
      liveLs: (async (options: { root: string }) => {
        calls.push({ activity: "liveLs", root: options.root });
        return { json: LS, estate: ESTATE, dir: fixtures };
      }) as unknown as TerraformReadDeps["liveLs"],
      ...overrides,
    } as TerraformReadDeps,
  };
}

/* ── the engine ──────────────────────────────────────────────────────────── */

const FIXTURE_ENGINE = "tariff";
const FIXTURE_VERSION = "0.0.1";

/** Rate per hour by provider type. Round numbers, so a delta is readable. */
const RATES: Readonly<Record<string, number>> = {
  aws_vpc: 0,
  aws_subnet: 0,
  aws_security_group: 0,
  aws_security_group_rule: 0,
  aws_cloudwatch_log_group: 1,
  aws_eip: 2,
  aws_s3_bucket: 8,
};

function providerTypeOf(props: Record<string, unknown>): string | undefined {
  const stated = props.resourceType;
  if (typeof stated === "string") return stated;
  const address = props.address;
  if (typeof address !== "string") return undefined;
  const dot = address.indexOf(".");
  return dot > 0 ? address.slice(0, dot) : undefined;
}

function figure(perHour: number, traffic: string): PredictedBehaviour {
  return {
    at: { traffic },
    cost: predictedRate(perHour, "USD"),
    headroom: { cpu: 0.5 },
    errorRate: 0,
    resilience: { failure: "one zone lost", verdict: "survives" },
    provenance: {
      engine: FIXTURE_ENGINE,
      version: FIXTURE_VERSION,
      tolerance: "±100%",
      basis: "modeled",
    },
  };
}

/**
 * The engine: a rate per provider type, and a stated decline for anything
 * else. Every name it is sent lands in one map or the other, which is the
 * contract's rule and also what keeps a total a sum over a known set.
 */
async function tariff(options: PredictBehaviourOptions): Promise<BehaviourResult> {
  const priced: Record<string, PredictedBehaviour> = Object.create(null) as Record<string, PredictedBehaviour>;
  const declined: Record<string, { type?: string; reason: "unsupported-kind"; detail: string }> = Object.create(
    null,
  ) as Record<string, { type?: string; reason: "unsupported-kind"; detail: string }>;
  let total = 0;
  for (const name of options.entityNames) {
    const entity = options.entities.get(name);
    const type = entity ? providerTypeOf(entity.props) : undefined;
    if (type === undefined || !Object.prototype.hasOwnProperty.call(RATES, type)) {
      declined[name] = {
        ...(entity ? { type: entity.entityType } : {}),
        reason: "unsupported-kind",
        detail: `${FIXTURE_ENGINE} prices no ${type ?? "block of this kind"}`,
      };
      continue;
    }
    total += RATES[type];
    priced[name] = figure(RATES[type], options.traffic);
  }
  return behaviourReport(
    options,
    { engine: FIXTURE_ENGINE, version: FIXTURE_VERSION, total: predictedRate(total, "USD") },
    priced,
    declined,
  );
}

/* ── helpers ─────────────────────────────────────────────────────────────── */

const common = { environment: "prod", buildOutput: "/tmp/build", traffic: "100 rps, p50" };

async function predict(
  overrides?: { owned?: boolean; deps?: Partial<TerraformReadDeps> },
): Promise<{ result: BehaviourResult; calls: Call[] }> {
  const d = deps(overrides?.deps);
  const result = await predictTerraformBehaviour(
    { ...common, entityNames, entities, ...(overrides?.owned ? { owned: true } : {}) },
    { liveLs: d.deps.liveLs, livePlan: d.deps.livePlan, predict: tariff },
  );
  return { result, calls: d.calls };
}

/**
 * The declared side: the same function, the same producer, `from: "declared"`.
 * The activities throw, so a run that reached for the account fails loudly
 * rather than quietly answering with it.
 */
async function predictDeclared(): Promise<BehaviourResult> {
  const reachedForTheAccount = (() => {
    throw new Error("the declared side read the account");
  }) as never;
  return predictTerraformBehaviour(
    { ...common, entityNames, entities, from: "declared" },
    { liveLs: reachedForTheAccount, livePlan: reachedForTheAccount, predict: tariff },
  );
}

function report(result: BehaviourResult): BehaviourReport {
  if (isBehaviourRefusalReport(result)) throw new Error(`refused: ${result.refusal.reason}`);
  return result;
}

/**
 * The report's `unpredicted` map. Optional on the type and omitted entirely
 * when empty (`behaviourReport`), so a run that predicted everything has no
 * key at all rather than an empty object — reading it through here keeps that
 * from reading as a missing entry.
 */
function unpredictedOf(result: BehaviourResult): Record<string, UnpredictedEntity> {
  return report(result).unpredicted ?? {};
}

const totalOf = (result: BehaviourResult): number => report(result).meta.total?.perHour ?? 0;

describe("which roots are read", () => {
  it("names the roots the build stamped live, and no other", () => {
    expect(liveRootsOf(entityNames, entities)).toEqual([ROOT]);
    // A root the build did not stamp live is never read: `describeResources`
    // branches the same way, and a stock root has no `live-ls` to run.
    const stock = new Map(
      [...entities].map(([name, e]) => [name, { ...e, props: { ...e.props, mode: "stock" } }]),
    );
    expect(liveRootsOf(entityNames, stock)).toEqual([]);
  });

  it("runs one live-ls and one live-plan for the root, and no stock activity", async () => {
    const { calls } = await predict();
    expect(calls).toEqual([
      { activity: "liveLs", root: ROOT },
      { activity: "livePlan", root: ROOT },
    ]);
  });
});

describe("the prediction of the account", () => {
  it("prices what the account holds, including what nothing declares", async () => {
    const { result } = await predict();
    const predicted = report(result);
    expect(Object.keys(predicted.entities)).toContain(key("aws_s3_bucket.data"));
    expect(predicted.entities[key("aws_s3_bucket.data")].cost.perHour).toBe(RATES.aws_s3_bucket);
    expect(predicted.meta.engine).toBe(FIXTURE_ENGINE);
    expect(predicted.meta.at.traffic).toBe(common.traffic);
  });

  it("leaves every name the caller asked about in one map or the other", async () => {
    const { result } = await predict();
    const predicted = report(result);
    const landed = new Set([...Object.keys(predicted.entities), ...Object.keys(unpredictedOf(result))]);
    // Everything asked about, minus what the account does not hold — a
    // resource the plan reported ABSENT is not the account's to predict, and
    // the declared side is where it is answered for.
    for (const name of entityNames) {
      if (name === key("aws_cloudwatch_log_group.never_applied")) continue;
      if (name === key("aws_security_group_rule.https")) continue;
      expect(landed.has(name), name).toBe(true);
    }
  });

  it("reports what --owned withheld as filtered, not as absent", async () => {
    const { result } = await predict({ owned: true });
    const predicted = report(result);
    const held = unpredictedOf(result)[key("aws_cloudwatch_log_group.held_elsewhere")];
    expect(held?.reason).toBe("filtered");
    expect(held?.detail).toContain("--owned");
    expect(Object.keys(predicted.entities)).not.toContain(key("aws_cloudwatch_log_group.held_elsewhere"));
  });
});

describe("a read that failed", () => {
  it("reports every resource of the root read-failed, naming the root, and sends none of them", async () => {
    const { result } = await predict({
      deps: {
        liveLs: (() => {
          throw new Error("no valid credential sources found for AWS Provider");
        }) as never,
      },
    });
    const predicted = report(result);
    const entry = unpredictedOf(result)[key("aws_vpc.main")];
    expect(entry?.reason).toBe("read-failed");
    expect(entry?.detail).toContain(`terraform.roots.${ROOT}`);
    // The failure names credentials, and saying so is the difference between
    // an operator checking a variable and one debugging an account.
    expect(entry?.detail).toContain("the failure names credentials");
    // Nothing of that root was priced: a failed read must never render as an
    // estate with nothing in it.
    expect(Object.keys(predicted.entities)).toEqual([]);
    expect(predicted.meta.total?.perHour).toBe(0);
  });

  it("does not claim credentials when the failure was something else", async () => {
    const { result } = await predict({
      deps: {
        livePlan: (() => {
          throw new Error("dial tcp 127.0.0.1:4660: connect: connection refused");
        }) as never,
      },
    });
    const entry = unpredictedOf(result)[key("aws_vpc.main")];
    expect(entry?.reason).toBe("read-failed");
    expect(entry?.detail).not.toContain("credentials");
    expect(entry?.detail).toContain("connection refused");
  });
});

describe("the screen runs before the engine", () => {
  it("refuses a request whose props carry a credential, and asks no engine", async () => {
    let asked = false;
    const tainted = new Map(entities);
    tainted.set(key("aws_vpc.main"), {
      entityType: "Terraform::Resource",
      props: {
        ...entities.get(key("aws_vpc.main"))!.props,
        body: { cidr_block: "10.99.0.0/16", awsSecretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" },
      },
    });
    const d = deps();
    const result = await predictTerraformBehaviour(
      { ...common, entityNames, entities: tainted },
      {
        liveLs: d.deps.liveLs,
        livePlan: d.deps.livePlan,
        predict: async () => {
          asked = true;
          throw new Error("the engine was asked after the screen refused");
        },
      },
    );
    expect(asked).toBe(false);
    expect(isBehaviourRefusalReport(result)).toBe(true);
    if (isBehaviourRefusalReport(result)) {
      expect(result.refusal.reason).toContain(TERRAFORM);
    }
  });
});

describe("the delta the epic asks for", () => {
  it("predicts a different figure for the drifted estate, by the size of the drift", async () => {
    const live = report((await predict()).result);
    const declared = report(await predictDeclared());

    // The recording's drift, and the whole of it: `storage.tf` was removed
    // after the apply, so the bucket is in the account and in no file; three
    // blocks were restored after the apply and never applied, two of which
    // the plan reports ABSENT.
    const onlyLive = Object.keys(live.entities).filter((n) => !(n in declared.entities));
    const onlyDeclared = Object.keys(declared.entities).filter((n) => !(n in live.entities));
    expect(onlyLive).toEqual([key("aws_s3_bucket.data")]);
    expect(onlyDeclared.sort()).toEqual([
      key("aws_cloudwatch_log_group.never_applied"),
      key("aws_security_group_rule.https"),
    ]);

    // The money moves by exactly the priced half of that: one bucket in, one
    // log group out. The rule is the third and prices at zero, so it moves the
    // membership and not the figure — which is why the membership is asserted
    // above rather than inferred from the total.
    expect(totalOf(live) - totalOf(declared)).toBe(RATES.aws_s3_bucket - RATES.aws_cloudwatch_log_group);
    expect(totalOf(declared)).toBe(RATES.aws_cloudwatch_log_group * 4 + RATES.aws_eip);
    expect(totalOf(live)).toBe(RATES.aws_cloudwatch_log_group * 3 + RATES.aws_eip + RATES.aws_s3_bucket);
  });

  it("keeps both sides comparable: same engine, same level, same basis", async () => {
    const live = report((await predict()).result);
    const declared = report(await predictDeclared());
    expect(live.meta.engine).toBe(declared.meta.engine);
    expect(live.meta.at).toEqual(declared.meta.at);
    // And the same edge-coverage claim, so a resilience verdict on one side is
    // not computed over a graph the other side does not have.
    expect(live.meta.edgeCoverage.verdict).toBe(declared.meta.edgeCoverage.verdict);
  });
});
