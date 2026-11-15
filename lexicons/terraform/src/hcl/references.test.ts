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

  it("reaches the expression of a Cloud Armor rule, seven levels down", () => {
    // hcl2json shape of `rule { match { expr { expression = "..." } } }`.
    const body = {
      name: "p",
      rule: [{ match: [{ expr: [{ expression: "${\"!request.path.matches('${join(\"|\", local.deep)}')\"}" }] }] }],
    } as never;
    expect(referencesInBody(body)).toContain("local.deep");
  });

  it("reaches a reference at any depth and keeps the providers rule there", () => {
    let deep: unknown = { x: "${var.bottom}", provider: "${aws.west}" };
    for (let i = 0; i < 200; i++) deep = { block: [deep] };
    const refs = referencesInBody(deep as never);
    expect(refs).toContain("var.bottom");
    expect(refs).toContain("provider.aws.west");
    let mapped: unknown = { providers: { aws: "${aws.east}" } };
    for (let i = 0; i < 50; i++) mapped = { block: [mapped] };
    expect(referencesInBody(mapped as never)).toContain("provider.aws.east");
  });

  it("survives a pathological body: 100000 levels, a cycle, a shared sub-object, a wide block", () => {
    let deep: unknown = { x: "${local.bottom}" };
    for (let i = 0; i < 100_000; i++) deep = { block: [deep] };
    expect(referencesInBody(deep as never)).toEqual(["local.bottom"]);

    const cyclic: Record<string, unknown> = { a: "${var.a}" };
    cyclic.self = cyclic;
    cyclic.list = [cyclic, { back: cyclic, b: "${var.b}" }];
    expect(referencesInBody(cyclic as never).sort()).toEqual(["var.a", "var.b"]);

    const shared = { s: "${local.shared}" };
    expect(referencesInBody({ one: shared, two: [shared, shared] } as never)).toEqual(["local.shared"]);

    const wide: Record<string, unknown> = {};
    for (let i = 0; i < 50_000; i++) wide[`k${i}`] = [{ v: `\${var.v${i % 100}}` }];
    const start = performance.now();
    expect(referencesInBody(wide as never)).toHaveLength(100);
    expect(performance.now() - start).toBeLessThan(2000);
  });
});

describe("a reference inside a nested block, parsed from HCL", () => {
  it("is found for the Cloud Armor rule shape", async () => {
    const source = [
      'locals {',
      '  shallow = ["a", "b"]',
      '  deep    = ["/", "/v2/.*"]',
      '}',
      'resource "google_compute_security_policy" "p" {',
      '  name = "p-${join("-", local.shallow)}"',
      '  rule {',
      '    action   = "deny(404)"',
      '    priority = "1"',
      '    match {',
      '      expr {',
      '        expression = "!request.path.matches(\'${join("|", local.deep)}\')"',
      '      }',
      '    }',
      '  }',
      '}',
      '',
    ].join("\n");
    const ents = await blocksToEntities([{ name: "main.tf", source }], "app");
    const idx = buildReferenceIndex(ents);
    expect(isReferenced(idx, "app", "local.deep", "app/locals")).toBe(true);
    expect(isReferenced(idx, "app", "local.shallow", "app/locals")).toBe(true);
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
