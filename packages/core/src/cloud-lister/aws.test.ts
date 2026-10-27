/**
 * behold#1029: the AWS lister against a fake Cloud Control. Response shapes
 * follow the pinned floci's CloudControlJsonHandler (source c688f52ee):
 * `{ TypeName, ResourceDescriptions: [{ Identifier, Properties }] }`, with
 * `Properties` a JSON string.
 */
import { describe, expect, it } from "vitest";
import { listCloud } from "./index";
import { ListerConfigError } from "./credentials";
import { MASKED } from "./mask";
import { signV4 } from "./sigv4";
import { fakeFetcher, json, refusingChains, steppingClock } from "./fakes";
import type { WireCall } from "./guard";

const ENDPOINT = "http://localhost:4566";
const CREDS = { accessKeyId: "test", secretAccessKey: "test" };

function target() {
  return { substrate: "aws" as const, aws: { endpoint: ENDPOINT, credentials: CREDS } };
}

function typeOf(call: WireCall): { TypeName: string; NextToken?: string } {
  return JSON.parse(call.body ?? "{}");
}

describe("signV4", () => {
  // AWS's published SigV4 test suite, case get-vanilla.
  it("matches the get-vanilla known answer", () => {
    const headers = signV4({
      method: "GET",
      url: "https://example.amazonaws.com/",
      headers: {},
      body: "",
      region: "us-east-1",
      service: "service",
      credentials: { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY" },
      now: new Date("2015-08-30T12:36:00Z"),
    });
    expect(headers.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
    );
  });
});

describe("listing aws", () => {
  it("lists each type per region, pages, and fills the listing-result shape", async () => {
    const fake = fakeFetcher((call) => {
      const { TypeName, NextToken } = typeOf(call);
      if (TypeName === "AWS::S3::Bucket" && !NextToken) {
        return json(200, {
          TypeName,
          ResourceDescriptions: [
            { Identifier: "web-assets", Properties: JSON.stringify({ BucketName: "web-assets", Arn: "arn:aws:s3:::web-assets", Tags: [{ Key: "tofu-estate", Value: "web" }, { Key: "tofu-address", Value: "aws_s3_bucket.assets" }] }) },
          ],
          NextToken: "page2",
        });
      }
      if (TypeName === "AWS::S3::Bucket" && NextToken === "page2") {
        return json(200, { TypeName, ResourceDescriptions: [{ Identifier: "logs", Properties: JSON.stringify({ BucketName: "logs" }) }] });
      }
      if (TypeName === "AWS::RDS::DBInstance") {
        return json(200, {
          TypeName,
          ResourceDescriptions: [{ Identifier: "db1", Properties: JSON.stringify({ DBInstanceIdentifier: "db1", MasterUserPassword: "hunter2", Tags: [{ Key: "api-token", Value: "abc" }] }) }],
        });
      }
      return undefined;
    });
    const result = await listCloud(
      { substrate: "aws", scopeId: "000000000000", locations: ["us-east-1"], types: ["AWS::S3::Bucket", "AWS::RDS::DBInstance"] },
      target(),
      { fetcher: fake.fetcher, chains: refusingChains(), now: steppingClock(), retryDelays: [], version: "0.30.2" },
    );

    expect(result.listing).toBe("v1");
    expect(result.source).toEqual({ name: "chant-lister", version: "0.30.2" });
    expect(result.scope.types).toEqual(["AWS::RDS::DBInstance", "AWS::S3::Bucket"]);
    expect(fake.calls.every((c) => c.url === `${ENDPOINT}/`)).toBe(true);
    expect(fake.calls[0].headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=test\/\d{8}\/us-east-1\/cloudcontrolapi\/aws4_request/);
    expect(fake.calls[0].headers["x-amz-target"]).toBe("CloudApiService.ListResources");

    const bucket = result.resources.find((r) => r.nativeId === "web-assets")!;
    expect(bucket.id).toBe("aws/000000000000/us-east-1/AWS::S3::Bucket/web-assets");
    expect(bucket.listedType).toBe("AWS::S3::Bucket");
    expect(bucket.location).toBe("us-east-1");
    expect(bucket.cloudIds).toEqual([
      { kind: "arn", value: "arn:aws:s3:::web-assets" },
      { kind: "import-id", value: "web-assets" },
    ]);
    expect(bucket.tags).toEqual({ "tofu-estate": "web", "tofu-address": "aws_s3_bucket.assets" });
    expect(bucket.facts).toEqual({
      markers: { owner: "web", address: "aws_s3_bucket.assets", encoding: "escaped", source: "live" },
      cloudIds: bucket.cloudIds,
      observedAt: bucket.observedAt,
    });
    expect(Object.keys(bucket.facts).sort()).toEqual(["cloudIds", "markers", "observedAt"]);
    expect(result.resources.map((r) => r.nativeId)).toContain("logs");

    const db = result.resources.find((r) => r.nativeId === "db1")!;
    expect(db.properties.MasterUserPassword).toBe(MASKED);
    expect(db.tags["api-token"]).toBe(MASKED);
    expect(JSON.stringify(result)).not.toContain("hunter2");
    expect(JSON.stringify(result)).not.toContain('"abc"');

    expect(result.coverage).toEqual([
      { listedType: "AWS::RDS::DBInstance", location: "us-east-1", verdict: "listed" },
      { listedType: "AWS::S3::Bucket", location: "us-east-1", verdict: "listed" },
    ]);
    expect(result.notes).toEqual([]);
  });

  it("lists a global type once, as location global", async () => {
    const fake = fakeFetcher(() => json(200, { ResourceDescriptions: [{ Identifier: "app-role", Properties: JSON.stringify({ RoleName: "app-role", Arn: "arn:aws:iam::000000000000:role/app-role" }) }] }));
    const result = await listCloud(
      { substrate: "aws", scopeId: "000000000000", locations: ["us-east-1", "eu-west-1"], types: ["AWS::IAM::Role"] },
      target(),
      { fetcher: fake.fetcher, chains: refusingChains(), now: steppingClock(), retryDelays: [] },
    );
    expect(fake.calls.length).toBe(1);
    expect(result.resources[0].id).toBe("aws/000000000000/global/AWS::IAM::Role/app-role");
    expect(result.coverage).toEqual([{ listedType: "AWS::IAM::Role", location: "global", verdict: "listed" }]);
  });

  it("puts a type it cannot list in the notes, with its reason", async () => {
    const fake = fakeFetcher((call) => {
      const { TypeName } = typeOf(call);
      if (TypeName === "AWS::Foo::Bar") return json(400, { __type: "com.amazon.cloudapiservice#UnsupportedActionException", message: "Resource type AWS::Foo::Bar does not support LIST action" });
      if (TypeName === "AWS::EC2::SubnetRouteTableAssociation") return json(400, { __type: "InvalidRequestException", message: "Missing Or Invalid ResourceModel property in AWS::EC2::SubnetRouteTableAssociation list handler request input" });
      if (TypeName === "AWS::S3::Bucket") return json(400, { __type: "AccessDeniedException", message: "not authorized" });
      return undefined;
    });
    const result = await listCloud(
      { substrate: "aws", scopeId: "000000000000", locations: ["us-east-1"], types: ["AWS::Foo::Bar", "AWS::EC2::SubnetRouteTableAssociation", "AWS::S3::Bucket"] },
      target(),
      { fetcher: fake.fetcher, chains: refusingChains(), now: steppingClock(), retryDelays: [] },
    );
    expect(result.resources).toEqual([]);
    expect(result.coverage.map((c) => [c.listedType, c.verdict])).toEqual([
      ["AWS::EC2::SubnetRouteTableAssociation", "unsupported-kind"],
      ["AWS::Foo::Bar", "unsupported-kind"],
      ["AWS::S3::Bucket", "no-credentials"],
    ]);
    expect(result.notes.map((n) => [n.code, n.listedType])).toEqual([
      ["needs-parent", "AWS::EC2::SubnetRouteTableAssociation"],
      ["no-lister", "AWS::Foo::Bar"],
      ["no-credentials", "AWS::S3::Bucket"],
    ]);
    expect(result.notes[1].message).toContain("does not support LIST");
  });

  it("filters by tag after listing, and marks coverage filtered", async () => {
    const fake = fakeFetcher(() =>
      json(200, {
        ResourceDescriptions: [
          { Identifier: "a", Properties: JSON.stringify({ Tags: [{ Key: "env", Value: "prod" }] }) },
          { Identifier: "b", Properties: JSON.stringify({ Tags: [{ Key: "env", Value: "dev" }] }) },
        ],
      }),
    );
    const result = await listCloud(
      { substrate: "aws", scopeId: "000000000000", locations: ["us-east-1"], types: ["AWS::SQS::Queue"], tagFilter: { env: "prod" } },
      target(),
      { fetcher: fake.fetcher, chains: refusingChains(), now: steppingClock(), retryDelays: [] },
    );
    expect(result.resources.map((r) => r.nativeId)).toEqual(["a"]);
    expect(result.coverage[0].verdict).toBe("filtered");
    expect(result.notes.map((n) => n.code)).toEqual(["tag-filter"]);
  });

  it('lists the default types for types "*" and says so', async () => {
    const fake = fakeFetcher(() => json(200, { ResourceDescriptions: [] }));
    const result = await listCloud(
      { substrate: "aws", scopeId: "000000000000", locations: ["us-east-1"], types: "*" },
      target(),
      { fetcher: fake.fetcher, chains: refusingChains(), now: steppingClock(), retryDelays: [] },
    );
    expect(result.notes[0].code).toBe("default-types");
    expect(fake.calls.length).toBeGreaterThan(20);
  });

  it("refuses every region, which would need a call off the allowlist", async () => {
    const fake = fakeFetcher(() => undefined);
    await expect(
      listCloud({ substrate: "aws", scopeId: "0", locations: "*", types: ["AWS::S3::Bucket"] }, target(), { fetcher: fake.fetcher, chains: refusingChains() }),
    ).rejects.toThrow(ListerConfigError);
    expect(fake.calls).toEqual([]);
  });

  it("never asks the default provider chain when an endpoint is given", async () => {
    const chains = refusingChains();
    const fake = fakeFetcher(() => undefined);
    await expect(
      listCloud(
        { substrate: "aws", scopeId: "0", locations: ["us-east-1"], types: ["AWS::S3::Bucket"] },
        { substrate: "aws", aws: { endpoint: ENDPOINT } },
        { fetcher: fake.fetcher, chains },
      ),
    ).rejects.toThrow(/needs static credentials/);
    expect(chains.count.aws).toBe(0);
    expect(fake.calls).toEqual([]);
  });
});
