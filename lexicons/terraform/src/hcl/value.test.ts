import { describe, test, expect } from "vitest";
import { attr } from "./value";
import type { BlockBody } from "./parse";

describe("attr(): the value envelope over a parsed block body (chant #2113)", () => {
  test("absent: the key is not present at all", () => {
    const body: BlockBody = {};
    expect(attr(body, "bucket")).toEqual({ kind: "absent", raw: undefined });
  });

  test("absent: null is treated the same as a missing key", () => {
    const body: BlockBody = { bucket: null };
    expect(attr(body, "bucket")).toEqual({ kind: "absent", raw: null });
  });

  test("literal: a plain string with no interpolation", () => {
    const body: BlockBody = { bucket: "my-bucket" };
    expect(attr(body, "bucket")).toEqual({ kind: "literal", value: "my-bucket", raw: "my-bucket" });
  });

  test("literal: a number", () => {
    const body: BlockBody = { count: 3 };
    expect(attr(body, "count")).toEqual({ kind: "literal", value: 3, raw: 3 });
  });

  test("literal: a boolean", () => {
    const body: BlockBody = { enabled: false };
    expect(attr(body, "enabled")).toEqual({ kind: "literal", value: false, raw: false });
  });

  test("literal: an array (also how hcl2json encodes a nested block under the same key)", () => {
    const body: BlockBody = { backend: [{ s3: [{ bucket: "tfstate" }] }] };
    const a = attr(body, "backend");
    expect(a.kind).toBe("literal");
    expect(a.value).toEqual([{ s3: [{ bucket: "tfstate" }] }]);
    expect(a.raw).toBe(a.value);
  });

  test("literal: an object", () => {
    const body: BlockBody = { tags: { team: "infra" } };
    expect(attr(body, "tags")).toEqual({ kind: "literal", value: { team: "infra" }, raw: { team: "infra" } });
  });

  test("reference: the whole string is one interpolation", () => {
    const body: BlockBody = { bucket: "${aws_s3_bucket.foo.id}" };
    expect(attr(body, "bucket")).toEqual({ kind: "reference", refs: ["aws_s3_bucket.foo.id"], raw: "${aws_s3_bucket.foo.id}" });
  });

  test("reference: a bare variable reference", () => {
    const body: BlockBody = { region: "${var.region}" };
    expect(attr(body, "region")).toEqual({ kind: "reference", refs: ["var.region"], raw: "${var.region}" });
  });

  test("reference: a function call still counts as one whole-string reference", () => {
    const body: BlockBody = { name: "${lower(var.name)}" };
    expect(attr(body, "name")).toEqual({ kind: "reference", refs: ["lower(var.name)"], raw: "${lower(var.name)}" });
  });

  test("template: interpolation mixed with literal text", () => {
    const body: BlockBody = { name: "prefix-${var.env}-suffix" };
    expect(attr(body, "name")).toEqual({ kind: "template", refs: ["var.env"], raw: "prefix-${var.env}-suffix" });
  });

  test("template: two interpolations in one string, both captured in source order", () => {
    const body: BlockBody = { name: "${var.a}-${var.b}" };
    expect(attr(body, "name")).toEqual({ kind: "template", refs: ["var.a", "var.b"], raw: "${var.a}-${var.b}" });
  });

  test("literal: a string that merely contains a bare $ with no interpolation", () => {
    const body: BlockBody = { price: "$5" };
    expect(attr(body, "price")).toEqual({ kind: "literal", value: "$5", raw: "$5" });
  });
});
