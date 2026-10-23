/**
 * The plan depth on a live choudoufu root (#4371): `live-plan -json` for
 * ownership, the plan read for the attributes, merged per block.
 *
 * The declared side is `src/__fixtures__/live-estate/`, rendered as
 * `buildRoots()` renders it. The read side is
 * `src/__fixtures__/live-plan-depth/`: a `live-plan -json` document and two
 * `show -json <planfile>` documents recorded from that configuration by the
 * choudoufu v0.30.0 release binary against the pinned floci emulator, with
 * drift made out of band (`live-plan-depth/README.md` is the log).
 *
 * Nothing here runs choudoufu: the activities are injected. The real binary
 * is `live-plan-depth.acceptance.test.ts`.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { normalizeObservation } from "@intentius/chant/observation";
import type { Declarable } from "@intentius/chant/declarable";
import { buildLiveGraphIr } from "@intentius/chant/graph-ir";
import { __searchInternals } from "@intentius/chant/cli/handlers/search";
import { describeResources, type TerraformReadDeps } from "./describe-resources";
import { TerraformPlanReadError } from "./op/activities/terraform";
import { PLAN_ATTRIBUTE_NAMES, SENSITIVE_VALUE } from "./plan-observation";
import { renderTerraformRoots } from "./hcl/roots";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__");
const RECORDED = join(fixtures, "live-plan-depth");
const ROOT_DIR = join(fixtures, "live-estate");
const LIVE_PLAN: unknown = JSON.parse(readFileSync(join(RECORDED, "live-plan.json"), "utf-8"));
const PLAN: unknown = JSON.parse(readFileSync(join(RECORDED, "show-plan.json"), "utf-8"));
const PLAN_SENSITIVE: unknown = JSON.parse(readFileSync(join(RECORDED, "show-plan-sensitive.json"), "utf-8"));
const ESTATE = "stateless-e2e-block";

type Entities = Map<string, { entityType: string; props: Record<string, unknown> }>;

/** The fixture root rendered under `binary`: `"choudoufu"` makes it live, `"terraform"` stock. */
async function declaredEntities(binary: "choudoufu" | "terraform"): Promise<Entities> {
  const { entities } = await renderTerraformRoots({
    projectRoot: fixtures,
    roots: { estate: { dir: "./live-estate" } },
    binary,
  });
  const out: Entities = new Map();
  for (const [key, entity] of entities) {
    out.set(key, { entityType: entity.entityType, props: (entity as Declarable & { props: Record<string, unknown> }).props });
  }
  return out;
}

async function options(binary: "choudoufu" | "terraform" = "choudoufu", depth: "plan" | "state" = "plan") {
  const entities = await declaredEntities(binary);
  return { environment: "prod", buildOutput: "", entityNames: [...entities.keys()].sort(), entities, depth };
}

const never = ((args: { root: string }) => {
  throw new Error(`unexpected activity for root "${args.root}"`);
}) as never;

const COMMAND = "choudoufu plan -input=false -lock=false -out=/tmp/chant-terraform-plan-x/plan.tfplan";

function deps(overrides?: Partial<TerraformReadDeps>, plan: unknown = PLAN): TerraformReadDeps {
  return {
    init: never,
    show: never,
    liveLs: never,
    livePlan: (async () => ({ json: LIVE_PLAN, dir: ROOT_DIR, estate: ESTATE })) as unknown as TerraformReadDeps["livePlan"],
    planRead: (async () => ({ json: plan, dir: ROOT_DIR, planDir: "/tmp/chant-terraform-plan-x", command: COMMAND })) as TerraformReadDeps["planRead"],
    ...overrides,
  };
}

const planOnly = (attributes: Record<string, unknown> | undefined): Record<string, unknown> =>
  Object.fromEntries(Object.entries(attributes ?? {}).filter(([k]) => k.startsWith("plan")));

const BOUND = [
  "estate/aws_cloudwatch_log_group.app",
  "estate/aws_eip.pool",
  "estate/aws_security_group.main",
  "estate/aws_subnet.app",
  "estate/aws_vpc.main",
];

describe("a live root at the plan depth carries the plan's attributes on bound blocks (#4371)", () => {
  it("drift made out of band is the planned update, live value before, declared value after", async () => {
    const result = normalizeObservation(await describeResources(await options(), deps()));
    const attrs = (name: string) => result.resources[`estate/${name}`]!.attributes as Record<string, unknown>;

    expect(attrs("aws_cloudwatch_log_group.app")).toMatchObject({
      planAction: "update",
      planChanges: [{ path: "retention_in_days", before: 3, after: 1 }],
    });
    expect(attrs("aws_vpc.main").planAction).toBe("update");
    expect(attrs("aws_vpc.main").planChanges).toEqual(
      expect.arrayContaining([
        { path: "tags.drifted", before: "yes", after: null },
        { path: "tags_all.drifted", before: "yes", after: null },
      ]),
    );
    expect(attrs("aws_eip.pool")).toMatchObject({
      planAction: "no-op",
      planActions: { "aws_eip.pool[0]": ["no-op"], "aws_eip.pool[1]": ["no-op"] },
    });
    // choudoufu rebuilds prior state from the account, so there is no
    // recorded state for `resource_drift` to compare against.
    for (const name of BOUND) expect(result.resources[name]!.attributes).not.toHaveProperty("planDrift");
  });

  it("ownership still comes from live-plan's markers, unchanged by the plan read", async () => {
    const atPlan = normalizeObservation(await describeResources(await options(), deps()));
    const atDefault = normalizeObservation(await describeResources(await options("choudoufu", "state"), deps({ planRead: never })));
    expect(Object.keys(atPlan.resources).sort()).toEqual(Object.keys(atDefault.resources).sort());
    expect(Object.keys(atPlan.unobserved).sort()).toEqual(Object.keys(atDefault.unobserved).sort());
    for (const [name, meta] of Object.entries(atDefault.resources)) {
      const merged = atPlan.resources[name]!;
      expect({ ...merged, attributes: undefined }).toEqual({ ...meta, attributes: undefined });
      const rest = Object.fromEntries(Object.entries(merged.attributes ?? {}).filter(([k]) => !k.startsWith("plan")));
      expect(rest, name).toEqual(meta.attributes);
    }
    expect(atPlan.resources["estate/aws_vpc.main"]!.marker).toEqual({ stack: ESTATE });
  });

  it("the plan attributes on a bound block are the ones a stock root gets from the same plan", async () => {
    const live = normalizeObservation(await describeResources(await options("choudoufu"), deps()));
    const stock = normalizeObservation(await describeResources(await options("terraform"), deps()));
    expect(new Set(Object.values(stock.sources))).toEqual(new Set(["plan"]));
    for (const name of BOUND) {
      const attrs = planOnly(live.resources[name]!.attributes);
      expect(Object.keys(attrs).length, name).toBeGreaterThan(0);
      expect(attrs, name).toEqual(planOnly(stock.resources[name]!.attributes));
      for (const key of Object.keys(attrs)) expect((PLAN_ATTRIBUTE_NAMES as readonly string[]).includes(key), key).toBe(true);
    }
  });

  it("a foreign or adoptable block gets no plan attributes, and a planned create stays absent", async () => {
    const result = normalizeObservation(await describeResources(await options(), deps()));
    const held = result.resources["estate/aws_cloudwatch_log_group.held_elsewhere"]!;
    const adoptable = result.resources["estate/aws_cloudwatch_log_group.adoptable"]!;
    expect(held.ownership).toBe("foreign");
    expect(adoptable.ownership).toBe("unknown");
    expect(planOnly(held.attributes)).toEqual({});
    expect(planOnly(adoptable.attributes)).toEqual({});
    expect(result.resources["estate/aws_cloudwatch_log_group.never_applied"]).toBeUndefined();
    expect(result.unobserved["estate/aws_cloudwatch_log_group.never_applied"]).toBeUndefined();
  });

  it("chant search matches the plan attributes on a live root", async () => {
    const result = normalizeObservation(await describeResources(await options(), deps()));
    const ir = buildLiveGraphIr([{ lexicon: "terraform", resources: result.resources }]);
    const { parseQuery, matchTerm } = __searchInternals;
    const search = (query: string) =>
      ir.nodes
        .filter((n) => parseQuery(query).every((t) => matchTerm(n, t, ir)))
        .map((n) => n.id)
        .sort();
    expect(search("attr:planAction=update")).toEqual(["estate/aws_cloudwatch_log_group.app", "estate/aws_vpc.main"]);
  });
});

describe("which reads answered is on the wire: \"live+plan\" (#4371)", () => {
  it("every entity of the root reads \"live+plan\", and the note names both reads", async () => {
    const opts = await options();
    const result = normalizeObservation(await describeResources(opts, deps()));
    expect(Object.keys(result.sources).sort()).toEqual([...opts.entityNames].sort());
    expect(new Set(Object.values(result.sources))).toEqual(new Set(["live+plan"]));
    expect(result.notes.join("\n")).toContain(
      "terraform.roots.estate: the plan read answered (`choudoufu plan -input=false -lock=false -out=<tmp>/plan.tfplan`), beside `live-plan -json`, which answered presence and ownership",
    );
    expect(result.queried["estate/aws_vpc.main"]).toMatch(/^choudoufu live-plan -json .*; choudoufu plan -input=false -lock=false .* \+ show -json <planfile>$/);
  });

  it("the default depth on a live root never calls the plan read and still reads \"live\"", async () => {
    const result = normalizeObservation(await describeResources(await options("choudoufu", "state"), deps({ planRead: never })));
    expect(new Set(Object.values(result.sources))).toEqual(new Set(["live"]));
    expect(planOnly(result.resources["estate/aws_vpc.main"]!.attributes)).toEqual({});
  });
});

describe("a live root falls back to live-plan alone, and says so (#4371)", () => {
  it("a plan read without provider credentials leaves live-plan's answer, reading \"live\"", async () => {
    const planRead = (async () => {
      throw new TerraformPlanReadError("plan", "choudoufu plan failed in /x: Error: No valid credential sources found", ROOT_DIR);
    }) as TerraformReadDeps["planRead"];
    const result = normalizeObservation(await describeResources(await options(), deps({ planRead })));
    const vpc = result.resources["estate/aws_vpc.main"]!;
    expect(vpc.ownership).toBe("owned");
    expect(planOnly(vpc.attributes)).toEqual({});
    expect(new Set(Object.values(result.sources))).toEqual(new Set(["live"]));
    expect(result.notes.join("\n")).toMatch(
      /terraform\.roots\.estate: the plan read failed \(no provider credentials: .*No valid credential sources found\), so `live-plan -json` alone answered; plan attributes are absent/,
    );
  });

  it("a root that needs init says so, and live-plan's answer stands", async () => {
    const planRead = (async () => {
      throw new TerraformPlanReadError("not-initialised", "terraform.roots.estate (/x) needs init (Error: Required plugins are not installed)", ROOT_DIR);
    }) as TerraformReadDeps["planRead"];
    const result = normalizeObservation(await describeResources(await options(), deps({ planRead })));
    expect(result.resources["estate/aws_vpc.main"]!.ownership).toBe("owned");
    expect(result.notes.join("\n")).toMatch(/the plan read failed \(the root needs init, which chant never runs: /);
  });

  it("a failed live-plan leaves the root not observed and never tries the plan read", async () => {
    const livePlan = (async () => {
      throw new Error("choudoufu live-plan failed in /x (exit 1)\nError: Provider unavailable for marker discovery");
    }) as unknown as TerraformReadDeps["livePlan"];
    const result = normalizeObservation(await describeResources(await options(), deps({ livePlan, planRead: never })));
    expect(Object.keys(result.resources)).toEqual([]);
    expect(result.unobserved["estate/aws_vpc.main"]!.reason).toBe("read-failed");
    expect(new Set(Object.values(result.sources))).toEqual(new Set(["live"]));
    expect(result.notes.join("\n")).toMatch(/terraform\.roots\.estate: no read answered \(`live-plan -json` failed, so the plan read was not tried\)/);
  });
});

describe("sensitive values on a live root (#4371)", () => {
  it("a secret is redacted on both sides, though choudoufu flags only the declared side", async () => {
    // Recorded: the tag was applied as "hunter2", then the variable changed to
    // "hunter3". The live value in `before` is the old secret, and the
    // document flags `after` only.
    const raw = readFileSync(join(RECORDED, "show-plan-sensitive.json"), "utf-8");
    expect(raw).toContain("hunter2");
    expect(raw).toContain("hunter3");
    const vpcChange = (PLAN_SENSITIVE as { resource_changes: Array<{ address: string; change: Record<string, unknown> }> }).resource_changes.find(
      (r) => r.address === "aws_vpc.main",
    )!.change;
    expect(vpcChange.before_sensitive).toEqual({ tags: {}, tags_all: {} });
    expect(vpcChange.after_sensitive).toEqual({ tags: { token: true }, tags_all: {} });

    const result = await describeResources(await options(), deps(undefined, PLAN_SENSITIVE));
    expect(JSON.stringify(result)).not.toMatch(/hunter[23]/);
    const vpc = normalizeObservation(result).resources["estate/aws_vpc.main"]!.attributes as Record<string, unknown>;
    expect(vpc.planChanges).toEqual(
      expect.arrayContaining([
        { path: "tags.token", before: SENSITIVE_VALUE, after: SENSITIVE_VALUE },
        // Unflagged on both sides; redacted because it equals a flagged value.
        { path: "tags_all.token", before: SENSITIVE_VALUE, after: SENSITIVE_VALUE },
      ]),
    );
  });
});
