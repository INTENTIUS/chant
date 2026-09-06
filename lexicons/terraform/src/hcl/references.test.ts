/**
 * The reference index (chant #2112), against
 * `src/__fixtures__/references/main.tf`, which carries every form the index
 * collects exactly once.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import type { Declarable } from "@intentius/chant/declarable";
import { blocksToEntities } from "./parse";
import {
  buildReferenceIndex,
  collectReferences,
  isReferenced,
  providerReference,
  referencesInBody,
  referencesTo,
  type ReferenceIndex,
} from "./references";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "..", "__fixtures__", "references", "main.tf");

let entities: Map<string, Declarable>;
let index: ReferenceIndex;

beforeAll(async () => {
  entities = await blocksToEntities([{ name: "main.tf", source: readFileSync(FIXTURE, "utf-8") }], "app");
  index = buildReferenceIndex(entities);
});

describe("collectReferences", () => {
  it("reads each reference form out of one expression string", () => {
    expect(collectReferences("${var.region}").sort()).toEqual(["var.region"]);
    expect(collectReferences("${local.tags}").sort()).toEqual(["local.tags"]);
    expect(collectReferences("${data.aws_ami.ubuntu.id}").sort()).toEqual(["data.aws_ami.ubuntu"]);
    expect(collectReferences("${module.cdn.url}").sort()).toEqual(["module.cdn"]);
  });

  it("does not read a data source as a bare type reference", () => {
    expect(collectReferences("${data.aws_ami.ubuntu.id}")).not.toContain("var.aws_ami");
  });

  it("reads several references out of one interpolated string", () => {
    expect(collectReferences("assets-${var.region}-${local.suffix}").sort()).toEqual([
      "local.suffix",
      "var.region",
    ]);
  });

  it("finds nothing in a string that names nothing", () => {
    expect(collectReferences("a plain value")).toEqual([]);
  });
});

describe("providerReference", () => {
  it("reads the provider meta-argument's own form", () => {
    expect(providerReference("${aws.replica}")).toBe("provider.aws.replica");
    expect(providerReference("aws.replica")).toBe("provider.aws.replica");
  });

  it("is not fooled by an expression that merely contains a dot", () => {
    expect(providerReference("${var.region}.example.com")).toBeUndefined();
    expect(providerReference(42)).toBeUndefined();
  });
});

describe("referencesInBody", () => {
  it("reads a provider reference from the meta-argument and from a providers map", () => {
    expect(referencesInBody({ provider: "${aws.replica}" })).toContain("provider.aws.replica");
    expect(referencesInBody({ providers: { aws: "${aws.replica}" } })).toContain("provider.aws.replica");
  });

  it("descends through nested blocks", () => {
    expect(referencesInBody({ tags: { Name: "${var.name}" } })).toContain("var.name");
  });
});

describe("buildReferenceIndex over the fixture", () => {
  it("collects every reference form in the root scope", () => {
    const refs = [...(index.scopes.get("app") ?? new Map()).keys()].sort();
    expect(refs).toEqual([
      "data.aws_ami.ubuntu",
      "local.bucket_name",
      "local.tags",
      "module.cdn",
      "provider.aws.replica",
      "var.region",
      "var.subnets",
    ]);
  });

  it("records which block each reference came from", () => {
    expect([...referencesTo(index, "app", "module.cdn")]).toEqual(["app/output.cdn_url"]);
    expect([...referencesTo(index, "app", "data.aws_ami.ubuntu")]).toEqual(["app/aws_instance.web"]);
  });

  it("counts a reference from the declaration's own body only when asked to", () => {
    // `local.bucket_name` is built from `var.region` inside the same `locals`
    // block, and read again by `aws_s3_bucket.replica`.
    expect([...referencesTo(index, "app", "var.region")]).toEqual(["app/locals"]);
    expect(isReferenced(index, "app", "var.region")).toBe(true);
    expect(isReferenced(index, "app", "var.region", "app/locals")).toBe(false);
  });

  it("knows nothing about a token nobody names", () => {
    expect(isReferenced(index, "app", "var.absent")).toBe(false);
    expect(referencesTo(index, "app", "var.absent").size).toBe(0);
  });

  it("keeps scopes apart", () => {
    expect(index.scopes.has("app")).toBe(true);
    expect(isReferenced(index, "app/module.cdn", "var.region")).toBe(false);
  });
});
