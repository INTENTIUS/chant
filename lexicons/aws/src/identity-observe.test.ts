/**
 * The identity fallback (#1647) — unit half. The carve state in miniature: a
 * declared Bucket absent from every stack, present live, named precisely by
 * its own `BucketName`. The Cloud Control edge is the injected `http` seam
 * `read-client` already exposes.
 */
import { describe, test, expect } from "vitest";
import { declaredIdentifier, observeByIdentity } from "./identity-observe";

const entity = (entityType: string, props: Record<string, unknown>) => ({ entityType, props });

describe("declaredIdentifier (#1647)", () => {
  test("a scalar primary identifier reads straight off the props", () => {
    expect(declaredIdentifier("AWS::S3::Bucket", { BucketName: "acme-platform-assets-prod" })).toBe(
      "acme-platform-assets-prod",
    );
  });

  test("absent, empty, or non-scalar identifier parts refuse — a Ref is not an identity", () => {
    expect(declaredIdentifier("AWS::S3::Bucket", {})).toBeUndefined();
    expect(declaredIdentifier("AWS::S3::Bucket", { BucketName: "" })).toBeUndefined();
    expect(declaredIdentifier("AWS::S3::Bucket", { BucketName: { Ref: "Other" } })).toBeUndefined();
  });

  test("an unknown type has no identifier to spell", () => {
    expect(declaredIdentifier("AWS::Made::Up", { Name: "x" })).toBeUndefined();
  });
});

/** A Cloud Control `GetResource` answer, double-encoded the way the API is. */
const ccFound = (identifier: string, properties: Record<string, unknown>) => ({
  status: 200,
  text: JSON.stringify({
    ResourceDescription: { Identifier: identifier, Properties: JSON.stringify(properties) },
  }),
});

const ccError = (type: string, message: string) => ({
  status: 400,
  text: JSON.stringify({ __type: type, message }),
});

describe("observeByIdentity (#1647)", () => {
  const bucket = new Map([["assets", entity("AWS::S3::Bucket", { BucketName: "acme-platform-assets-prod" })]]);

  test("a live identifier-named resource reads OBSERVED — external, foreign, never absent", async () => {
    const calls: Array<{ url: string; body: string }> = [];
    const { resources, queried } = await observeByIdentity(["assets"], bucket, {}, {
      http: async (url, init) => {
        calls.push({ url, body: init.body });
        return ccFound("acme-platform-assets-prod", { BucketName: "acme-platform-assets-prod", SecretToken: "s3cr3t" });
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("cloudcontrol");
    expect(resources.assets).toMatchObject({
      type: "AWS::S3::Bucket",
      physicalId: "acme-platform-assets-prod",
      status: "EXTERNAL",
      ownership: "foreign",
    });
    // Live properties ride along, sensitive keys scrubbed like stack outputs.
    expect(resources.assets.attributes).toMatchObject({ BucketName: "acme-platform-assets-prod", SecretToken: "[REDACTED]" });
    // #1620: the attempted address is on the wire whatever the verdict.
    expect(queried.assets).toContain("AWS::S3::Bucket");
    expect(queried.assets).toContain("acme-platform-assets-prod");
  });

  test("a genuine miss keeps the stack's absent verdict, with the address still recorded", async () => {
    const { resources, queried } = await observeByIdentity(["assets"], bucket, {}, {
      http: async () => ccError("ResourceNotFoundException", "no such bucket"),
    });
    expect(resources.assets).toBeUndefined();
    expect(queried.assets).toBeDefined();
  });

  test("an emulator without Cloud Control at all keeps the absent verdict — never a hole, or pre-first-apply plans stop proposing create", async () => {
    const { resources } = await observeByIdentity(["assets"], bucket, {}, {
      http: async () => ccError("UnsupportedOperation", "not supported"),
    });
    expect(resources.assets).toBeUndefined();
  });

  // Floci serves ListResources but answers UnsupportedOperation for
  // GetResource (read-client's own note) — and the emulator is where the carve
  // walkthrough films the observe beat. Verified against Floci 1.5.34 on the
  // behold demo: the list leg is what turns the miss into a read.
  test("GetResource-unsupported falls back to ListResources and matches the identifier (Floci)", async () => {
    const targets: string[] = [];
    const { resources } = await observeByIdentity(["assets"], bucket, {}, {
      http: async (_url, init) => {
        const target = (init.headers as Record<string, string>)["x-amz-target"] ?? "";
        targets.push(target);
        if (target.endsWith("GetResource")) return ccError("UnsupportedOperation", "Operation GetResource is not supported.");
        return {
          status: 200,
          text: JSON.stringify({
            ResourceDescriptions: [
              { Identifier: "some-other-bucket", Properties: JSON.stringify({ BucketName: "some-other-bucket" }) },
              { Identifier: "acme-platform-assets-prod", Properties: JSON.stringify({ BucketName: "acme-platform-assets-prod" }) },
            ],
          }),
        };
      },
    });
    expect(targets.some((t) => t.endsWith("ListResources"))).toBe(true);
    expect(resources.assets).toMatchObject({
      type: "AWS::S3::Bucket",
      physicalId: "acme-platform-assets-prod",
      status: "EXTERNAL",
      ownership: "foreign",
    });
  });

  test("the list leg missing the identifier keeps the absent verdict", async () => {
    const { resources } = await observeByIdentity(["assets"], bucket, {}, {
      http: async (_url, init) => {
        const target = (init.headers as Record<string, string>)["x-amz-target"] ?? "";
        if (target.endsWith("GetResource")) return ccError("UnsupportedOperation", "not supported");
        return { status: 200, text: JSON.stringify({ ResourceDescriptions: [] }) };
      },
    });
    expect(resources.assets).toBeUndefined();
  });

  test("entities the stack already answered for are never re-read", async () => {
    let called = 0;
    const already = { assets: { type: "AWS::S3::Bucket", physicalId: "b", status: "CREATE_COMPLETE" } };
    const { resources } = await observeByIdentity(["assets"], bucket, already, {
      http: async () => ((called += 1), ccFound("x", {})),
    });
    expect(called).toBe(0);
    expect(resources).toEqual({});
  });

  test("entities with no spellable identifier are skipped without a call", async () => {
    let called = 0;
    const anonymous = new Map([["q", entity("AWS::SQS::Queue", {})]]);
    const { resources, queried } = await observeByIdentity(["q"], anonymous, {}, {
      http: async () => ((called += 1), ccFound("x", {})),
    });
    expect(called).toBe(0);
    expect(resources).toEqual({});
    expect(queried).toEqual({});
  });
});
