/**
 * terraform describeResources on a live root (#2104).
 *
 * The declared side is real: `renderTerraformRoots` parses
 * `src/__fixtures__/live-estate/` under `binary: "choudoufu"` exactly as
 * `buildRoots()` does, so every key matched here is a key a build produces,
 * and the sidecar in that directory is what makes the root live.
 *
 * The live side is real too. `src/__fixtures__/live-plan.json` and
 * `src/__fixtures__/live-ls.json` were recorded from that same configuration
 * by a choudoufu built from source, running against choudoufu's own pinned
 * floci emulator; `src/__fixtures__/live-estate/README.md` is the recording
 * log, including the two ways the recording could not be a chant live root.
 *
 * Nothing here runs choudoufu: the activities are injected, and the stock
 * `show` activity throws if the reader ever reaches for it.
 */

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { describeObservationConformance } from "@intentius/chant-test-utils";
import { normalizeObservation } from "@intentius/chant/observation";
import type { Declarable } from "@intentius/chant/declarable";
import {
  ambientKinds,
  describeResources,
  indexLivePlan,
  liveRootNames,
  observeAmbient,
  readLiveLs,
  teardownOwned,
  LIVE_PLAN_OMISSION_REASONS,
  TERRAFORM_LIVE_MARKER_KEYS,
  type TerraformReadDeps,
} from "./describe-resources";
import { renderTerraformRoots } from "./hcl/roots";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__");
const ROOT_DIR = join(fixtures, "live-estate");
const PLAN: unknown = JSON.parse(readFileSync(join(fixtures, "live-plan.json"), "utf-8"));
const LS: unknown = JSON.parse(readFileSync(join(fixtures, "live-ls.json"), "utf-8"));
const ESTATE = "stateless-e2e-block";

const workspaces: string[] = [];
afterAll(() => {
  for (const dir of workspaces) rmSync(dir, { recursive: true, force: true });
});

/** A real project on disk: the fixture root plus the config that makes it live. */
function project(): string {
  const dir = mkdtempSync(join(tmpdir(), "chant-terraform-live-"));
  workspaces.push(dir);
  cpSync(ROOT_DIR, join(dir, "root"), { recursive: true });
  writeFileSync(
    join(dir, "chant.config.json"),
    JSON.stringify({
      lexicons: ["terraform"],
      terraform: { binary: "choudoufu", roots: { estate: { dir: "./root" } } },
    }),
  );
  return dir;
}

/** `buildRoots()`'s own render of the live fixture root, keyed `<root>/<address>`. */
async function declaredEntities(): Promise<Map<string, { entityType: string; props: Record<string, unknown> }>> {
  const { entities } = await renderTerraformRoots({
    projectRoot: fixtures,
    roots: { estate: { dir: "./live-estate" } },
    binary: "choudoufu",
  });
  const out = new Map<string, { entityType: string; props: Record<string, unknown> }>();
  for (const [key, entity] of entities) {
    out.set(key, {
      entityType: entity.entityType,
      props: (entity as Declarable & { props: Record<string, unknown> }).props,
    });
  }
  return out;
}

/** A stock activity that must never be reached on a live root. */
const neverStock = (() => {
  throw new Error("terraform show was run on a live root: there is no state file to show");
}) as never;

function deps(overrides?: Partial<TerraformReadDeps>): TerraformReadDeps {
  return {
    init: neverStock,
    show: neverStock,
    livePlan: (async () => ({
      drift: true,
      json: PLAN,
      text: "",
      // The adoption ledger fields (#2105) are a projection of the same
      // document; `describeResources` reads none of them, so the stub carries
      // the empty shape rather than a second copy of PLAN's unowned rows.
      ledger: "",
      finding: "",
      adoptions: [],
      contested: [],
      ambiguous: 0,
      dir: ROOT_DIR,
      documentPath: "chant.live-plan.json",
      estate: ESTATE,
      unowned: 2,
      adoptable: 1,
    })) as TerraformReadDeps["livePlan"],
    liveLs: (async () => ({ json: LS, dir: ROOT_DIR, estate: ESTATE })) as TerraformReadDeps["liveLs"],
    ...overrides,
  };
}

const failingPlan = (message: string): TerraformReadDeps["livePlan"] =>
  (async () => {
    throw new Error(message);
  }) as TerraformReadDeps["livePlan"];

async function options(overrides?: { owned?: boolean; only?: string[]; extra?: Map<string, { entityType: string; props: Record<string, unknown> }> }) {
  const entities = overrides?.extra ?? (await declaredEntities());
  const entityNames = overrides?.only ?? [...entities.keys()].sort();
  return {
    environment: "prod",
    buildOutput: "",
    entityNames,
    entities,
    ...(overrides?.owned ? { owned: true } : {}),
  };
}

describe("the live fixture root is what buildRoots() calls live (#2103)", () => {
  it("stamps mode live and the estate on every entity of the root", async () => {
    const entities = await declaredEntities();
    expect(entities.size).toBeGreaterThan(0);
    for (const entity of entities.values()) {
      expect(entity.props.mode).toBe("live");
      expect(entity.props.estate).toBe(ESTATE);
    }
  });

  it("keys the count block by its block address, which the document keys by instance", async () => {
    const entities = await declaredEntities();
    expect([...entities.keys()]).toContain("estate/aws_eip.pool");
    expect([...entities.keys()]).not.toContain("estate/aws_eip.pool[0]");
  });
});

describe("indexLivePlan (#2104)", () => {
  const index = indexLivePlan(PLAN);

  it("indexes every section of the recorded document by address", () => {
    expect(index.estate).toBe(ESTATE);
    expect([...index.bound.keys()].sort()).toEqual([
      "aws_cloudwatch_log_group.app",
      "aws_eip.pool[0]",
      "aws_eip.pool[1]",
      "aws_security_group.main",
      "aws_subnet.app",
      "aws_vpc.main",
    ]);
    expect([...index.unowned.keys()].sort()).toEqual([
      "aws_cloudwatch_log_group.adoptable",
      "aws_cloudwatch_log_group.held_elsewhere",
    ]);
    expect(index.omissions.get("aws_cloudwatch_log_group.never_applied")!.reason).toBe("ABSENT");
  });

  it("separates an adoptable match from a resource another estate holds", () => {
    expect(index.unowned.get("aws_cloudwatch_log_group.adoptable")).toMatchObject({
      adoptEstate: ESTATE,
      adoptAddress: "aws_cloudwatch_log_group.adoptable",
    });
    expect(index.unowned.get("aws_cloudwatch_log_group.held_elsewhere")).toMatchObject({
      heldBy: "other-estate",
    });
    expect(index.unowned.get("aws_cloudwatch_log_group.held_elsewhere")!.adoptEstate).toBeUndefined();
  });

  it("reads a document with no sections at all as empty, never as a throw", () => {
    expect(indexLivePlan({}).addresses).toEqual([]);
    expect(indexLivePlan(null).bound.size).toBe(0);
  });
});

describe("the omission reason table (#2104)", () => {
  it("maps ABSENT to absence, because the provider was asked and answered", () => {
    expect(LIVE_PLAN_OMISSION_REASONS.ABSENT).toBe("absent");
  });

  it("maps a failure to read-failed and an unreachable kind to unsupported-kind", () => {
    expect(LIVE_PLAN_OMISSION_REASONS.FAILED).toBe("read-failed");
    expect(LIVE_PLAN_OMISSION_REASONS.NEEDS_DISCOVERY).toBe("unsupported-kind");
    expect(LIVE_PLAN_OMISSION_REASONS.UNREADABLE).toBe("unsupported-kind");
  });
});

describe("terraform describeResources on a live root (#2104)", () => {
  it("reads live-plan and never terraform show", async () => {
    // `deps()`'s init and show throw. Reaching this line means neither ran.
    const { resources } = normalizeObservation(await describeResources(await options(), deps()));
    expect(Object.keys(resources).length).toBeGreaterThan(0);
    const { queried } = normalizeObservation(await describeResources(await options(), deps()));
    expect(queried["estate/aws_vpc.main"]).toBe(
      `choudoufu live-plan -json (root "estate", estate "${ESTATE}", address "aws_vpc.main")`,
    );
  });

  it("reports a marker-bound instance owned, and surfaces the estate as its marker", async () => {
    const { resources } = normalizeObservation(await describeResources(await options(), deps()));
    expect(resources["estate/aws_vpc.main"]).toMatchObject({
      type: "Terraform::Resource",
      physicalId: "vpc-c1733cf7",
      status: "bound",
      ownership: "owned",
      marker: { stack: ESTATE },
    });
    expect(resources["estate/aws_vpc.main"].attributes).toMatchObject({
      address: "aws_vpc.main",
      root: "estate",
      estate: ESTATE,
      resourceType: "aws_vpc",
      boundBy: "marker",
    });
  });

  it("aggregates a count block over the instance addresses the document carries", async () => {
    const { resources } = normalizeObservation(await describeResources(await options(), deps()));
    const pool = resources["estate/aws_eip.pool"];
    expect(pool).toMatchObject({ ownership: "owned", marker: { stack: ESTATE } });
    expect(pool.attributes!.instances).toEqual(["aws_eip.pool[0]", "aws_eip.pool[1]"]);
  });

  it("reports a declaration-carried bind owned by derivation, with no marker claimed", async () => {
    const { resources } = normalizeObservation(await describeResources(await options(), deps()));
    const log = resources["estate/aws_cloudwatch_log_group.app"];
    expect(log).toMatchObject({ ownership: "owned", status: "bound" });
    expect(log.attributes!.boundBy).toBe("derived");
    // Nothing was read off this resource, so nothing is claimed about it.
    expect(log.marker).toBeUndefined();
  });

  it("reports an adoptable match unknown, carrying the exact tag write that claims it", async () => {
    const { resources } = normalizeObservation(await describeResources(await options(), deps()));
    const adoptable = resources["estate/aws_cloudwatch_log_group.adoptable"];
    expect(adoptable).toMatchObject({
      status: "adoptable",
      ownership: "unknown",
      physicalId: "/stateless-e2e-block/adoptable",
    });
    expect(adoptable.attributes).toMatchObject({
      adoptTofuEstate: ESTATE,
      adoptTofuAddress: "aws_cloudwatch_log_group.adoptable",
    });
    expect(adoptable.marker).toBeUndefined();
  });

  it("reports an unowned resource at a declared identity foreign, naming who holds it", async () => {
    const { resources } = normalizeObservation(await describeResources(await options(), deps()));
    const held = resources["estate/aws_cloudwatch_log_group.held_elsewhere"];
    expect(held).toMatchObject({ status: "unowned", ownership: "foreign" });
    expect(held.attributes!.heldBy).toBe("other-estate");
    expect(held.marker).toBeUndefined();
  });

  it("reports an ABSENT omission as absent, so a create is still proposable", async () => {
    const { resources, unobserved, queried } = normalizeObservation(
      await describeResources(await options(), deps()),
    );
    for (const name of [
      "estate/aws_cloudwatch_log_group.never_applied",
      "estate/aws_security_group_rule.https",
    ]) {
      expect(resources).not.toHaveProperty(name);
      expect(unobserved).not.toHaveProperty(name);
      expect(queried[name]).toContain("live-plan");
    }
  });

  it("reports a data block unsupported-kind: the document is prior state for managed resources", async () => {
    const entities = await declaredEntities();
    entities.set("estate/data.aws_ami.base", {
      entityType: "Terraform::Data",
      props: { address: "data.aws_ami.base", root: "estate", mode: "live", estate: ESTATE, body: {}, file: "x.tf" },
    });
    const { unobserved } = normalizeObservation(
      await describeResources(await options({ extra: entities, only: ["estate/data.aws_ami.base"] }), deps()),
    );
    expect(unobserved["estate/data.aws_ami.base"].reason).toBe("unsupported-kind");
    expect(unobserved["estate/data.aws_ami.base"].detail).toContain("prior state");
  });

  it("reports the terraform and provider blocks unsupported-kind", async () => {
    const { unobserved } = normalizeObservation(await describeResources(await options(), deps()));
    for (const name of ["estate/terraform", "estate/provider.aws", "estate/live"]) {
      expect(unobserved[name].reason).toBe("unsupported-kind");
      expect(unobserved[name].detail).toContain("live-plan document");
    }
  });

  it("notes, once for the run, that ownership came from the marker rather than a state file", async () => {
    const { notes } = normalizeObservation(await describeResources(await options(), deps()));
    expect(notes.join("\n")).toContain("terraform.roots.estate is a live root");
    expect(notes.join("\n")).toContain("tofu-estate");
  });
});

describe("terraform describeResources live-root failures (#2104)", () => {
  it("reports every declared entity of the root not-observed, never absent", async () => {
    const opts = await options();
    const { resources, unobserved } = normalizeObservation(
      await describeResources(opts, deps({ livePlan: failingPlan("Error: No configuration files") })),
    );
    expect(Object.keys(resources)).toEqual([]);
    expect(Object.keys(unobserved).sort()).toEqual([...opts.entityNames].sort());
    for (const entry of Object.values(unobserved)) {
      expect(entry.reason).toBe("read-failed");
      expect(entry.detail).toContain("terraform.roots.estate");
    }
  });

  it("calls a credentials failure no-credentials, not read-failed", async () => {
    const opts = await options();
    const { unobserved } = normalizeObservation(
      await describeResources(
        opts,
        deps({ livePlan: failingPlan("no valid credential sources for AWS Provider found") }),
      ),
    );
    for (const name of opts.entityNames) expect(unobserved[name].reason).toBe("no-credentials");
  });

  it("calls a refused configuration read-failed, with choudoufu's own first line", async () => {
    const opts = await options();
    const { unobserved } = normalizeObservation(
      await describeResources(
        opts,
        deps({
          livePlan: failingPlan(
            "choudoufu live-plan failed in /root (exit 1)\nEstate named by both the live block and -estate",
          ),
        }),
      ),
    );
    expect(unobserved[opts.entityNames[0]!].detail).toContain("choudoufu live-plan failed");
  });
});

describe("terraform describeResources --owned on a live root (#2104)", () => {
  it("keeps the owned reads and withholds the foreign and adoptable ones as filtered", async () => {
    const { resources, unobserved } = normalizeObservation(
      await describeResources(await options({ owned: true }), deps()),
    );
    expect(Object.keys(resources).sort()).toEqual([
      "estate/aws_cloudwatch_log_group.app",
      "estate/aws_eip.pool",
      "estate/aws_security_group.main",
      "estate/aws_subnet.app",
      "estate/aws_vpc.main",
    ]);
    expect(unobserved["estate/aws_cloudwatch_log_group.adoptable"].reason).toBe("filtered");
    expect(unobserved["estate/aws_cloudwatch_log_group.held_elsewhere"].reason).toBe("filtered");
  });
});

describe("readLiveLs (#2104)", () => {
  const listing = readLiveLs(LS);

  it("parses the recorded listing's items, slots and gaps", () => {
    expect(listing.estate).toBe(ESTATE);
    expect(listing.items).toHaveLength(7);
    expect(listing.items.find((i) => i.address === "aws_eip.pool[0]")!.slot).toBe("0");
    expect(listing.items.find((i) => i.address === "aws_s3_bucket.data")!.declared).toBe(false);
    expect(listing.gaps).toEqual([
      {
        address: "aws_security_group_rule.https",
        type: "aws_security_group_rule",
        rung: "declaration-carried",
        detail: expect.stringContaining("no settable tags argument"),
      },
    ]);
  });

  it("reads a listing with no items at all as empty, never as a throw", () => {
    expect(readLiveLs({}).items).toEqual([]);
    expect(readLiveLs(null).gaps).toEqual([]);
  });
});

describe("the estate beyond the declaration (#1278, #2104)", () => {
  it("enumerates the project's live roots out of terraform.roots", async () => {
    expect(await liveRootNames(project())).toEqual([{ root: "estate", estate: ESTATE }]);
  });

  it("names resource blocks as the one ambient kind", () => {
    expect(ambientKinds()).toEqual(["Terraform::Resource"]);
  });

  it("reports the estate's owned orphans, and only those", async () => {
    const ambient = await observeAmbient(
      { environment: "prod", kinds: ["Terraform::Resource"], observed: {}, cwd: project() },
      deps(),
    );
    expect(Object.keys(ambient)).toEqual(["estate/aws_s3_bucket.data"]);
    expect(ambient["estate/aws_s3_bucket.data"]).toMatchObject({
      type: "Terraform::Resource",
      physicalId: "arn:aws:s3:::tofu-stateless-e2e-block-data",
      status: "orphan",
      ownership: "owned",
      ambient: true,
      marker: { stack: ESTATE },
    });
    expect(ambient["estate/aws_s3_bucket.data"].attributes!.tags).toMatchObject({
      "tofu-estate": ESTATE,
      "tofu-address": "aws_s3_bucket.data",
    });
  });

  it("excludes anything describeResources already observed", async () => {
    const ambient = await observeAmbient(
      {
        environment: "prod",
        kinds: ["Terraform::Resource"],
        observed: { "estate/aws_s3_bucket.data": { type: "Terraform::Resource", status: "bound" } },
        cwd: project(),
      },
      deps(),
    );
    expect(ambient).toEqual({});
  });

  it("enumerates nothing when the project declares no resource blocks", async () => {
    const ambient = await observeAmbient(
      { environment: "prod", kinds: ["Terraform::Module"], observed: {}, cwd: project() },
      deps(),
    );
    expect(ambient).toEqual({});
  });
});

describe("teardownOwned on a live root (#1222, #2104)", () => {
  it("names the owned orphans choudoufu's own default policy would delete", async () => {
    const marker = { stack: "chant", env: "prod" };
    const enumeration = await teardownOwned({ environment: "prod", marker, cwd: project() }, deps());
    expect(enumeration.candidates).toEqual([
      {
        name: "estate/aws_s3_bucket.data",
        type: "Terraform::Resource",
        physicalId: "arn:aws:s3:::tofu-stateless-e2e-block-data",
        marker,
      },
    ]);
  });

  it("turns a listing gap into a hole rather than silence", async () => {
    const enumeration = await teardownOwned(
      { environment: "prod", marker: { stack: "chant", env: "prod" }, cwd: project() },
      deps(),
    );
    expect(enumeration.holes).toEqual([
      {
        name: "estate/aws_security_group_rule.https",
        type: "Terraform::Resource",
        reason: "unsupported-kind",
        detail: expect.stringContaining("declaration-carried"),
      },
    ]);
  });

  it("turns a failed listing into a hole, never into an empty candidate list", async () => {
    const enumeration = await teardownOwned(
      { environment: "prod", marker: { stack: "chant", env: "prod" }, cwd: project() },
      deps({
        liveLs: (async () => {
          throw new Error("ThrottlingException: Rate exceeded");
        }) as TerraformReadDeps["liveLs"],
      }),
    );
    expect(enumeration.candidates).toEqual([]);
    expect(enumeration.holes![0]).toMatchObject({
      name: "terraform.roots.estate",
      reason: "read-failed",
    });
  });
});

describe("the live ownership channel (#2104)", () => {
  it("names choudoufu's two marker tags", () => {
    expect(TERRAFORM_LIVE_MARKER_KEYS).toEqual({
      managedBy: "tofu-estate",
      stack: "tofu-estate",
      env: "tofu-address",
    });
  });
});

describeObservationConformance({
  lexicon: "terraform (live root)",
  // The same declaration the plugin makes: this path resolves a real verdict,
  // read here off choudoufu's markers rather than off a state file.
  ownershipChannel: { keys: TERRAFORM_LIVE_MARKER_KEYS, reads: ["describeResources"] },
  scenarios: [
    {
      name: "a marker-bound resource",
      declared: ["estate/aws_vpc.main"],
      expectPresent: ["estate/aws_vpc.main"],
      expectMarker: { "estate/aws_vpc.main": { stack: ESTATE, env: undefined } },
      run: async () => describeResources(await options({ only: ["estate/aws_vpc.main"] }), deps()),
    },
    {
      name: "an adoptable match, which carries no marker of its own",
      declared: ["estate/aws_cloudwatch_log_group.adoptable"],
      expectPresent: ["estate/aws_cloudwatch_log_group.adoptable"],
      expectNoMarker: ["estate/aws_cloudwatch_log_group.adoptable"],
      run: async () =>
        describeResources(await options({ only: ["estate/aws_cloudwatch_log_group.adoptable"] }), deps()),
    },
    {
      name: "a resource another estate holds at a declared identity",
      declared: ["estate/aws_cloudwatch_log_group.held_elsewhere"],
      expectPresent: ["estate/aws_cloudwatch_log_group.held_elsewhere"],
      expectNoMarker: ["estate/aws_cloudwatch_log_group.held_elsewhere"],
      run: async () =>
        describeResources(await options({ only: ["estate/aws_cloudwatch_log_group.held_elsewhere"] }), deps()),
    },
    {
      name: "declared and never applied",
      declared: ["estate/aws_cloudwatch_log_group.never_applied"],
      expectAbsent: ["estate/aws_cloudwatch_log_group.never_applied"],
      run: async () =>
        describeResources(await options({ only: ["estate/aws_cloudwatch_log_group.never_applied"] }), deps()),
    },
    {
      name: "live-plan itself failed",
      declared: ["estate/aws_vpc.main", "estate/aws_eip.pool"],
      expectUnobserved: ["estate/aws_vpc.main", "estate/aws_eip.pool"],
      run: async () =>
        describeResources(
          await options({ only: ["estate/aws_vpc.main", "estate/aws_eip.pool"] }),
          deps({ livePlan: failingPlan("no valid credential sources for AWS Provider found") }),
        ),
    },
    {
      name: "a data block, which the document has no row for",
      declared: ["estate/data.aws_ami.base"],
      expectUnobserved: ["estate/data.aws_ami.base"],
      run: async () => {
        const entities = await declaredEntities();
        entities.set("estate/data.aws_ami.base", {
          entityType: "Terraform::Data",
          props: {
            address: "data.aws_ami.base",
            root: "estate",
            mode: "live",
            estate: ESTATE,
            body: {},
            file: "x.tf",
          },
        });
        return describeResources(
          await options({ extra: entities, only: ["estate/data.aws_ami.base"] }),
          deps(),
        );
      },
    },
    {
      name: "owned read, with the adoptable and foreign rows filtered out",
      declared: [
        "estate/aws_vpc.main",
        "estate/aws_cloudwatch_log_group.adoptable",
        "estate/aws_cloudwatch_log_group.held_elsewhere",
      ],
      owned: true,
      expectPresent: ["estate/aws_vpc.main"],
      expectUnobserved: [
        "estate/aws_cloudwatch_log_group.adoptable",
        "estate/aws_cloudwatch_log_group.held_elsewhere",
      ],
      run: async () =>
        describeResources(
          await options({
            owned: true,
            only: [
              "estate/aws_vpc.main",
              "estate/aws_cloudwatch_log_group.adoptable",
              "estate/aws_cloudwatch_log_group.held_elsewhere",
            ],
          }),
          deps(),
        ),
    },
  ],
});
