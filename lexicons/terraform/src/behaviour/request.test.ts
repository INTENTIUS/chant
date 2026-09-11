/**
 * The behaviour engine's request, built from the account and from the file (#2360).
 *
 * Both sides run against the same recorded floci estate
 * `../describe-resources.live.test.ts` uses: `../__fixtures__/live-estate/` is
 * parsed by `renderTerraformRoots` exactly as `buildRoots()` parses it, and
 * `../__fixtures__/live-plan.json` and `../__fixtures__/live-ls.json` were
 * recorded from that configuration by the choudoufu v0.15.0 release binary
 * against choudoufu's pinned floci image (`live-estate/README.md` is the
 * recording log). So the drift asserted below is drift a run produced, not
 * drift a fixture author typed: `storage.tf` was removed after the apply, and
 * three blocks were restored after it and never applied.
 *
 * Nothing here runs choudoufu. The two documents are already parsed, and
 * `terraformBehaviourRequest` is pure over them.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import type { Declarable } from "@intentius/chant/declarable";
import { indexLivePlan, readLiveLs } from "../describe-resources";
import { renderTerraformRoots } from "../hcl/roots";
import {
  blockAddressOf,
  edgeCoverageOf,
  regionOfArn,
  substituteReferences,
  terraformBehaviourRequest,
  type LiveResourceFacts,
  type TerraformBehaviourEntity,
  type TerraformBehaviourRequest,
} from "./request";
import { isUnresolvedKind, REFERENCES_NOTHING, TERRAFORM_REFERENCE_CATALOG } from "./reference-catalog";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "..", "__fixtures__");
const PLAN = indexLivePlan(JSON.parse(readFileSync(join(fixtures, "live-plan.json"), "utf-8")));
const LISTING = readLiveLs(JSON.parse(readFileSync(join(fixtures, "live-ls.json"), "utf-8")));
const ROOT = "estate";

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

const common = { environment: "prod", buildOutput: "/tmp/build", traffic: "100 rps, p50" };

const declaredSide = (): TerraformBehaviourRequest =>
  terraformBehaviourRequest({ ...common, entityNames, entities });

const liveSide = (): TerraformBehaviourRequest =>
  terraformBehaviourRequest({
    ...common,
    entityNames,
    entities,
    live: [{ root: ROOT, listing: LISTING, plan: PLAN }],
  });

const factsOf = (built: TerraformBehaviourRequest, address: string): LiveResourceFacts =>
  (built.request.entities.get(key(address))!.props as { live: LiveResourceFacts }).live;

describe("the declared side", () => {
  it("builds every declared block, from the file and nothing else", () => {
    const built = declaredSide();
    expect(built.request.entityNames).toEqual(entityNames);
    expect(built.absent).toEqual([]);
    expect(built.unpredicted).toEqual({});
    expect(new Set(Object.values(built.sources))).toEqual(new Set(["declared"]));
    // No block carries a live fact, because no account was read.
    for (const [, entity] of built.request.entities) {
      expect(Object.prototype.hasOwnProperty.call(entity.props, "live")).toBe(false);
    }
  });

  it("resolves a reference to the entity it names", () => {
    // `aws_security_group_rule.https` names `aws_security_group.main` through
    // `security_group_id`; nothing else in this root references anything.
    expect(declaredSide().request.edges).toEqual([
      {
        from: key("aws_security_group_rule.https"),
        to: key("aws_security_group.main"),
        kind: "ref",
        viaAttr: "security_group_id",
      },
    ]);
  });
});

describe("the live side", () => {
  it("predicts what the account holds, including what nothing declares", () => {
    const built = liveSide();
    // `storage.tf` was removed after the apply, so the bucket it created is
    // still in the account and in no file. It is in the request all the same:
    // the live path predicts the account as it stands.
    expect(built.request.entityNames).toContain(key("aws_s3_bucket.data"));
    expect(declaredSide().request.entityNames).not.toContain(key("aws_s3_bucket.data"));
    const orphan = built.request.entities.get(key("aws_s3_bucket.data"))!;
    expect(orphan.props.resourceType).toBe("aws_s3_bucket");
    expect(orphan.props.root).toBe(ROOT);
    expect(orphan.props.estate).toBe("stateless-e2e-block");
    // No body: the listing carries an identity and a type, never arguments.
    expect(orphan.props.body).toBeUndefined();
    expect(factsOf(built, "aws_s3_bucket.data")).toEqual({
      status: "orphan",
      ownership: "owned",
      arn: "arn:aws:s3:::tofu-stateless-e2e-block-data",
      tags: { "tofu-address": "aws_s3_bucket.data", "tofu-estate": "stateless-e2e-block" },
    });
  });

  it("leaves a declared resource the account does not hold out of the request, and names it", () => {
    const built = liveSide();
    // Both were declared and never applied; the plan reports them ABSENT.
    expect(built.absent).toEqual([
      key("aws_cloudwatch_log_group.never_applied"),
      key("aws_security_group_rule.https"),
    ]);
    for (const name of built.absent) {
      expect(built.request.entityNames).not.toContain(name);
      // Not `unpredicted` either: the contract has no reason meaning "the
      // account does not hold it", and calling it one would report a
      // successful read as a failed one.
      expect(Object.prototype.hasOwnProperty.call(built.unpredicted, name)).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(built.sources, name)).toBe(false);
    }
    expect(declaredSide().request.entityNames).toEqual(expect.arrayContaining(built.absent));
  });

  it("carries the identity, the ARN and the region each document states", () => {
    const built = liveSide();
    expect(factsOf(built, "aws_vpc.main")).toEqual({
      status: "bound",
      ownership: "owned",
      identity: "vpc-dc8685c5",
      arn: "arn:aws:ec2:us-east-1:000000000000:vpc/vpc-dc8685c5",
      region: "us-east-1",
    });
    // A global ARN names no region, and none is invented for it.
    expect(factsOf(built, "aws_s3_bucket.data").region).toBeUndefined();
  });

  it("distinguishes bound, adoptable and foreign rather than calling them all present", () => {
    const built = liveSide();
    expect(factsOf(built, "aws_subnet.app").status).toBe("bound");
    // Content-matched by the estate sweep: a live VPC at the declared cidr,
    // carrying no marker.
    expect(factsOf(built, "aws_vpc.adoptable")).toMatchObject({ status: "adoptable", ownership: "unknown" });
    expect(factsOf(built, "aws_cloudwatch_log_group.adoptable")).toMatchObject({
      status: "adoptable",
      identity: "/stateless-e2e-block/adoptable",
    });
    // Another estate's, and still in the account: the prediction says whose.
    expect(factsOf(built, "aws_cloudwatch_log_group.held_elsewhere")).toMatchObject({
      status: "foreign",
      ownership: "foreign",
      heldBy: "other-estate",
    });
  });

  it("withholds what is not this estate's when --owned was asked for", () => {
    const built = terraformBehaviourRequest({
      ...common,
      entityNames,
      entities,
      owned: true,
      live: [{ root: ROOT, listing: LISTING, plan: PLAN }],
    });
    for (const address of ["aws_vpc.adoptable", "aws_cloudwatch_log_group.adoptable", "aws_cloudwatch_log_group.held_elsewhere"]) {
      const entry = built.unpredicted[key(address)];
      expect(entry?.reason, address).toBe("filtered");
      expect(entry?.detail, address).toContain("--owned");
      expect(built.request.entityNames).not.toContain(key(address));
    }
    // The estate's own are unaffected.
    expect(built.request.entityNames).toContain(key("aws_vpc.main"));
    expect(built.request.entityNames).toContain(key("aws_s3_bucket.data"));
  });

  it("keeps a count block one entity and states its instances", () => {
    // The request's unit is the entity the caller asked about. `aws_eip.pool`
    // is one name in one build, and the two slots the account holds ride as a
    // fact rather than as two entities nobody asked about.
    const built = liveSide();
    expect(built.request.entityNames.filter((n) => n.startsWith(key("aws_eip.pool")))).toEqual([
      key("aws_eip.pool"),
    ]);
    expect(factsOf(built, "aws_eip.pool").instances).toEqual(["aws_eip.pool[0]", "aws_eip.pool[1]"]);
  });

  it("leaves a block that is not a resource alone, on both sides alike", () => {
    // A `terraform` settings block, a provider configuration and the estate
    // sidecar are not things an account holds, so the account says nothing
    // about them and neither side invents a verdict.
    for (const address of ["terraform", "provider.aws", "live"]) {
      const live = liveSide().request.entities.get(key(address))!;
      const declared = declaredSide().request.entities.get(key(address))!;
      expect(live, address).toEqual(declared);
    }
  });
});

describe("the delta between the two sides", () => {
  it("is membership, and is exactly the drift the recording introduced", () => {
    const declared = new Set(declaredSide().request.entityNames);
    const live = new Set(liveSide().request.entityNames);
    expect([...live].filter((n) => !declared.has(n))).toEqual([key("aws_s3_bucket.data")]);
    expect([...declared].filter((n) => !live.has(n)).sort()).toEqual([
      key("aws_cloudwatch_log_group.never_applied"),
      key("aws_security_group_rule.https"),
    ]);
  });

  it("is not a difference in how the two graphs were assembled", () => {
    // The third review comment on #2360: until both sides produce containment,
    // a "one zone lost" verdict differs between them for a reason that is not
    // drift. One producer runs the same catalog over both, so the subnet's and
    // the security group's membership of the VPC is on each.
    expect(liveSide().request.edgeCoverage.containmentEdges).toEqual(
      declaredSide().request.edgeCoverage.containmentEdges,
    );
    expect(declaredSide().request.edgeCoverage.containmentEdges).toEqual([
      { from: key("aws_security_group.main"), to: key("aws_vpc.main"), kind: "ref", viaAttr: "vpc_id" },
      { from: key("aws_subnet.app"), to: key("aws_vpc.main"), kind: "ref", viaAttr: "vpc_id" },
    ]);
  });

  it("loses the one reference edge, because the resource that made it was never applied", () => {
    // Not a defect in the reconstruction: `aws_security_group_rule.https` is
    // ABSENT, so the account holds nothing to have a reference.
    expect(liveSide().request.edges).toEqual([]);
    expect(declaredSide().request.edges).toHaveLength(1);
  });
});

describe("edgeCoverage states what was reconstructed", () => {
  it("claims complete only when nothing is missing", () => {
    expect(edgeCoverageOf({ dangling: [], containmentEdges: [] }, [])).toEqual({
      verdict: "complete",
      containmentEdges: [],
    });
  });

  it("is partial, with the list, when a reference left the estate", () => {
    const dangling = [{ from: "web", path: "subnet_id", value: "subnet-gone", targetKind: "aws_subnet" }];
    const coverage = edgeCoverageOf({ dangling, containmentEdges: [] }, []);
    expect(coverage.verdict).toBe("partial");
    // Carried through unflattened: `from` is what says whose argument leaves.
    expect(coverage.dangling).toEqual(dangling);
  });

  it("is partial, naming the kinds, when nothing was looked for", () => {
    const coverage = edgeCoverageOf({ dangling: [], containmentEdges: [] }, ["aws_zebra", "aws_aardvark"]);
    expect(coverage.verdict).toBe("partial");
    expect(coverage.unresolvedKinds).toEqual(["aws_aardvark", "aws_zebra"]);
  });

  it("counts a kind with no rule, and does not count one known to reference nothing", () => {
    // The two causes of "no rule" that should not read alike: nobody has
    // written one, and there is nothing to write one about.
    expect(isUnresolvedKind("aws_kinesis_stream")).toBe(true);
    expect(isUnresolvedKind("aws_vpc")).toBe(false);
    expect(REFERENCES_NOTHING.has("aws_vpc")).toBe(true);
    for (const kind of REFERENCES_NOTHING) {
      expect(
        TERRAFORM_REFERENCE_CATALOG.refs.some((r) => r.from === kind),
        `${kind} is listed as referencing nothing and has a rule`,
      ).toBe(false);
    }
  });

  it("says complete for this estate, because every kind in it was looked at", () => {
    for (const built of [declaredSide(), liveSide()]) {
      expect(built.request.edgeCoverage.verdict, JSON.stringify(built.request.edgeCoverage)).toBe("complete");
    }
  });
});

describe("the pieces the two sides share", () => {
  it("reads a block address off an instance address", () => {
    expect(blockAddressOf("aws_eip.pool[0]")).toBe("aws_eip.pool");
    expect(blockAddressOf('aws_subnet.this["a"]')).toBe("aws_subnet.this");
    expect(blockAddressOf("aws_vpc.main")).toBe("aws_vpc.main");
  });

  it("reads a region off an ARN, and nothing off a global one", () => {
    expect(regionOfArn("arn:aws:ec2:us-east-1:000000000000:vpc/vpc-dc8685c5")).toBe("us-east-1");
    expect(regionOfArn("arn:aws:s3:::tofu-stateless-e2e-block-data")).toBeUndefined();
    expect(regionOfArn("not-an-arn")).toBeUndefined();
  });

  it("substitutes a reference only when one reference explains the whole value", () => {
    const references = [
      { to: "net/aws_vpc.main", viaAttr: "vpc_id", toAttr: "id" },
      { to: "net/aws_subnet.app", viaAttr: "subnet_id", toAttr: "id" },
    ];
    const addressOf = (to: string): string | undefined =>
      ({ "net/aws_vpc.main": "aws_vpc.main", "net/aws_subnet.app": "aws_subnet.app" })[to];
    const resolve = (to: string): string | undefined =>
      ({ "net/aws_vpc.main": "vpc-dc8685c5", "net/aws_subnet.app": "subnet-b870b7fc" })[to];

    expect(
      substituteReferences(
        { vpc_id: "${aws_vpc.main.id}", subnet_id: "${aws_subnet.app.id}", cidr_block: "10.0.0.0/16" },
        references,
        addressOf,
        resolve,
      ),
    ).toEqual({ vpc_id: "vpc-dc8685c5", subnet_id: "subnet-b870b7fc", cidr_block: "10.0.0.0/16" });

    // A composed value is not an identifier, and a reference whose target the
    // account does not hold stays put — which is what makes it come back from
    // the resolver as dangling rather than silently vanishing.
    expect(
      substituteReferences(
        { vpc_id: "${aws_vpc.main.id}-suffix", subnet_id: "${aws_subnet.gone.id}" },
        [...references, { to: "net/aws_subnet.gone", viaAttr: "subnet_id", toAttr: "id" }],
        (to) => (to === "net/aws_subnet.gone" ? "aws_subnet.gone" : addressOf(to)),
        resolve,
      ),
    ).toEqual({ vpc_id: "${aws_vpc.main.id}-suffix", subnet_id: "${aws_subnet.gone.id}" });
  });

  it("substitutes inside a nested block, under the argument that owns it", () => {
    expect(
      substituteReferences(
        { vpc_config: [{ subnet_ids: ["${aws_subnet.app.id}"] }] },
        [{ to: "net/aws_subnet.app", viaAttr: "vpc_config", toAttr: "id" }],
        () => "aws_subnet.app",
        () => "subnet-b870b7fc",
      ),
    ).toEqual({ vpc_config: [{ subnet_ids: ["subnet-b870b7fc"] }] });
  });
});
