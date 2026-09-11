/**
 * The coverage table's own invariants (#2357).
 *
 * The table is data, so most of what can go wrong with it is a shape problem:
 * a type in both halves, a kind outside the closed set, a declared-unmapped row
 * whose reason says nothing. Each of those turns the table from a statement
 * into a shrug, and none of them is visible by reading `mapping.ts` top to
 * bottom once it has more than a screenful of rows.
 */

import { describe, expect, it } from "vitest";
import {
  byCodeUnit,
  DECLARED_UNMAPPED,
  DECLARED_UNMAPPED_TERRAFORM,
  ENGINE_KINDS,
  ENGINE_KINDS_BY_ENTITY_TYPE,
  ENGINE_KINDS_BY_TERRAFORM_TYPE,
  TERRAFORM_RESOURCE_TYPE,
  augurCoverageTable,
  coverageFor,
  coverageLabel,
  isEngineKind,
  terraformCoverageFor,
  terraformResourceType,
  unmappedDetail,
} from "./mapping";
import { PROFILE_TYPE } from "./resources";

describe("the coverage table", () => {
  it("puts no entity type in both halves", () => {
    // A type that is mapped and declared unmapped at once has two answers, and
    // `coverageFor` would silently prefer the first.
    const both = Object.keys(ENGINE_KINDS_BY_ENTITY_TYPE).filter((t) =>
      Object.prototype.hasOwnProperty.call(DECLARED_UNMAPPED, t),
    );
    expect(both).toEqual([]);
  });

  it("maps every row to a kind from the closed set", () => {
    for (const [type, mapping] of Object.entries(ENGINE_KINDS_BY_ENTITY_TYPE)) {
      expect(isEngineKind(mapping.kind), `${type} has kind ${mapping.kind}`).toBe(true);
      expect(["aws", "kubernetes"], `${type} has provider ${mapping.provider}`).toContain(mapping.provider);
    }
  });

  it("gives every declared-unmapped row a reason that says something", () => {
    // "not supported" is not a reason. A row here is a decision somebody made,
    // and the sentence is what a reader of a report gets instead of a figure.
    for (const [type, reason] of Object.entries(DECLARED_UNMAPPED)) {
      expect(reason.trim().length, `${type} states no reason`).toBeGreaterThan(20);
      expect(reason.trim().toLowerCase(), `${type}'s reason says nothing`).not.toMatch(
        /^(n\/a|none|unsupported|not supported|tbd|-)\.?$/,
      );
    }
  });

  it("declares this lexicon's own resource unmapped", () => {
    // A profile is the question. Sending it would ask an engine to price the
    // asking, and the example's build produces two of them.
    expect(coverageFor(PROFILE_TYPE).status).toBe("declared-unmapped");
  });

  it("is total: every type resolves to exactly one of three states", () => {
    const seen = new Set<string>();
    for (const type of [
      ...Object.keys(ENGINE_KINDS_BY_ENTITY_TYPE),
      ...Object.keys(DECLARED_UNMAPPED),
      "Acme::Widget::Thing",
      "",
    ]) {
      const verdict = coverageFor(type);
      expect(["mapped", "declared-unmapped", "unknown-type"]).toContain(verdict.status);
      seen.add(verdict.status);
    }
    expect([...seen].sort()).toEqual(["declared-unmapped", "mapped", "unknown-type"]);
  });

  it("is not fooled by a prototype key", () => {
    // `ENGINE_KINDS_BY_ENTITY_TYPE["constructor"]` is a function on a bare
    // object literal, and a truthiness check on it would report a type nobody
    // declared as mapped to a kind that does not exist.
    expect(coverageFor("constructor").status).toBe("unknown-type");
    expect(coverageFor("toString").status).toBe("unknown-type");
    expect(coverageFor("__proto__").status).toBe("unknown-type");
  });

  it("names the kind in the detail, both ways round", () => {
    const role = unmappedDetail("AWS::IAM::Role", coverageFor("AWS::IAM::Role"));
    expect(role).toContain("AWS::IAM::Role");
    expect(role).toContain("declared unmapped by the augur coverage table");

    const unknown = unmappedDetail("Acme::Widget::Thing", coverageFor("Acme::Widget::Thing"));
    expect(unknown).toContain("Acme::Widget::Thing");
    expect(unknown).toContain("neither mapped to an engine kind nor declared unmapped");
    // The difference between the two is the whole reason the second table
    // exists: one is a decision, the other is a gap in this file.
    expect(unknown).not.toEqual(role);
  });

  it("renders every half as one sorted table", () => {
    const rows = augurCoverageTable();
    expect(rows.length).toBe(
      Object.keys(ENGINE_KINDS_BY_ENTITY_TYPE).length +
        Object.keys(DECLARED_UNMAPPED).length +
        Object.keys(ENGINE_KINDS_BY_TERRAFORM_TYPE).length +
        Object.keys(DECLARED_UNMAPPED_TERRAFORM).length,
    );
    const types = rows.map((r) => r.entityType);
    expect(types).toEqual([...types].sort(byCodeUnit));
    expect(rows.filter((r) => r.kind === "—").length).toBe(
      Object.keys(DECLARED_UNMAPPED).length + Object.keys(DECLARED_UNMAPPED_TERRAFORM).length,
    );
  });

  it("keeps the kind witness and the exported list in step", () => {
    expect(ENGINE_KINDS.length).toBe(new Set(ENGINE_KINDS).size);
    for (const kind of ENGINE_KINDS) expect(isEngineKind(kind)).toBe(true);
    expect(isEngineKind("compute-ish")).toBe(false);
    expect(isEngineKind(undefined)).toBe(false);
  });
});

describe("the terraform half of the coverage table (#2360)", () => {
  it("puts no provider type in both halves", () => {
    const both = Object.keys(ENGINE_KINDS_BY_TERRAFORM_TYPE).filter((t) =>
      Object.prototype.hasOwnProperty.call(DECLARED_UNMAPPED_TERRAFORM, t),
    );
    expect(both).toEqual([]);
  });

  it("maps every row to a kind from the closed set, reading its size from the block body", () => {
    for (const [type, mapping] of Object.entries(ENGINE_KINDS_BY_TERRAFORM_TYPE)) {
      expect(isEngineKind(mapping.kind), `${type} has kind ${mapping.kind}`).toBe(true);
      expect(mapping.provider, type).toBe("aws");
      expect(type.startsWith("aws_"), `${type} is not an aws provider type`).toBe(true);
      // The block's arguments are under `body` on the entity, and a size path
      // that does not start there reads the entity's own fields instead.
      if (mapping.sizeProp) expect(mapping.sizeProp.startsWith("body."), `${type}'s size is not under body`).toBe(true);
      if (mapping.sizeProp) expect(mapping.sizeType, `${type} names a size and no type`).toBeDefined();
    }
  });

  it("gives every declared-unmapped row a reason that says something", () => {
    for (const [type, reason] of Object.entries(DECLARED_UNMAPPED_TERRAFORM)) {
      expect(reason.trim().length, `${type} states no reason`).toBeGreaterThan(20);
    }
  });

  it("dispatches a resource block on its provider type, and is total over that", () => {
    // The props a block arrives with: an address and a body, never a `type`.
    const props = (type: string) => ({ address: `${type}.block`, body: {} });
    expect(coverageFor(TERRAFORM_RESOURCE_TYPE, props("aws_instance")).status).toBe("mapped");
    expect(coverageFor(TERRAFORM_RESOURCE_TYPE, props("aws_vpc")).status).toBe("declared-unmapped");
    expect(coverageFor(TERRAFORM_RESOURCE_TYPE, props("aws_imaginary_thing")).status).toBe("unknown-type");
    expect(coverageFor(TERRAFORM_RESOURCE_TYPE, props("azurerm_storage_account")).status).toBe("provider-not-modelled");
    // A provider this table has never heard of is still a stated boundary,
    // named by its prefix, because augur models aws and nothing else here.
    const other = coverageFor(TERRAFORM_RESOURCE_TYPE, props("cloudflare_record"));
    expect(other.status).toBe("provider-not-modelled");
    if (other.status === "provider-not-modelled") expect(other.substrate).toContain("cloudflare");
    // Prototype keys, as on the main table: the lookup answers off its own
    // rows, not off `Object.prototype`. A block addressed `constructor.x`
    // never reaches it — `constructor` is not shaped like a terraform type —
    // so the guard is checked where it lives.
    expect(terraformCoverageFor("constructor").status).toBe("provider-not-modelled");
    expect(terraformCoverageFor("__proto__").status).toBe("provider-not-modelled");
    expect(coverageFor(TERRAFORM_RESOURCE_TYPE, props("constructor")).status).toBe("unknown-type");
    expect(coverageFor(TERRAFORM_RESOURCE_TYPE, { address: 42 }).status).toBe("unknown-type");
  });

  it("reads the provider type off the address, and off a live row's own statement of it", () => {
    // A `type` prop is what the first draft of this table looked for, and
    // nothing produces one: a block that carried only that is the same "no
    // opinion" an entity with no props at all gets.
    expect(terraformResourceType({ type: "aws_instance" })).toBeUndefined();
    expect(terraformResourceType({ address: "aws_instance.web", body: {} })).toBe("aws_instance");
    // A descended child module's block keeps an unqualified address; the
    // calling chain is beside it and the `module.<name>` segments are in the
    // entity's key.
    expect(
      terraformResourceType({ address: "aws_cloudfront_distribution.cdn", callers: ["module.cdn"] }),
    ).toBe("aws_cloudfront_distribution");
    // An undeclared live resource states its type itself, because it has no
    // terraform address for one to be read out of.
    expect(terraformResourceType({ address: "arn:aws:s3:::bucket", resourceType: "aws_s3_bucket" })).toBe(
      "aws_s3_bucket",
    );
    // …and with neither, an identity standing in for an address is not sliced
    // at a dot it happens to contain.
    expect(terraformResourceType({ address: "arn:aws:s3:::my.bucket.name" })).toBeUndefined();
    expect(terraformResourceType({ address: "aws_instance" })).toBeUndefined();
    expect(terraformResourceType(undefined)).toBeUndefined();
  });

  it("names the provider type in the detail, and points at the terraform table for a gap", () => {
    const vpcProps = { address: "aws_vpc.main", body: {} };
    const vpc = unmappedDetail(
      coverageLabel(TERRAFORM_RESOURCE_TYPE, vpcProps),
      coverageFor(TERRAFORM_RESOURCE_TYPE, vpcProps),
    );
    expect(vpc).toContain("aws_vpc (Terraform::Resource)");
    expect(vpc).toContain("declared unmapped by the augur coverage table");

    const gapProps = { address: "aws_imaginary_thing.one", body: {} };
    const gap = unmappedDetail(
      coverageLabel(TERRAFORM_RESOURCE_TYPE, gapProps),
      coverageFor(TERRAFORM_RESOURCE_TYPE, gapProps),
    );
    expect(gap).toContain("aws_imaginary_thing");
    expect(gap).toContain("lexicons/augur/src/mapping-terraform.ts");
    // A CloudFormation gap still points at the main table.
    expect(unmappedDetail("AWS::Imaginary::Thing", coverageFor("AWS::Imaginary::Thing"))).toContain(
      "lexicons/augur/src/mapping.ts",
    );
  });
});
