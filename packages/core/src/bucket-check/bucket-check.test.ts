/**
 * chant#4558: the shared fixture set through chant's evaluators, and the
 * wire behaviour against fake fetchers (no socket is opened, no cloud is
 * reached, no credential chain is asked).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fakeFetcher, refusingChains, steppingClock } from "../cloud-lister/fakes";
import { ListerConfigError } from "../cloud-lister/credentials";
import type { WireResponse } from "../cloud-lister/transport";
import {
  BUCKET_SETTINGS,
  BucketCheckError,
  checkBucket,
  evaluateAzure,
  evaluateGcs,
  evaluateS3,
  refusedFindings,
  type AzureInput,
  type BucketFinding,
  type GcsInput,
  type S3Input,
} from "./index";
import { parseLifecycle, parsePublicAccessBlock, parseVersioning } from "./s3";

interface Case<I> {
  name: string;
  bucket?: string;
  account?: string;
  resourceGroup?: string;
  container?: string;
  namespaces: string[];
  input: I;
  expect: Array<{ setting: string; verdict: string; unwaivable: boolean }>;
}

function load<I>(store: string): { store: string; cases: Array<Case<I>> } {
  return JSON.parse(readFileSync(new URL(`./fixtures/${store}.json`, import.meta.url), "utf8"));
}

const shape = (fs: BucketFinding[]) => fs.map((f) => ({ setting: f.setting, verdict: f.verdict, unwaivable: f.unwaivable }));

describe("shared fixtures", () => {
  const s3 = load<S3Input>("s3");
  it.each(s3.cases.map((c) => [c.name, c] as const))("s3 %s", (_n, c) => {
    const findings = evaluateS3(c.input, { bucket: c.bucket!, namespaces: c.namespaces });
    expect(shape(findings)).toEqual(c.expect);
    for (const f of findings) {
      expect(f.found).not.toBe("");
      if (f.verdict !== "ok") expect(f.fix).toBeTruthy();
    }
  });

  const gcs = load<GcsInput>("gcs");
  it.each(gcs.cases.map((c) => [c.name, c] as const))("gcs %s", (_n, c) => {
    expect(shape(evaluateGcs(c.input, { bucket: c.bucket!, namespaces: c.namespaces }))).toEqual(c.expect);
  });

  const azure = load<AzureInput>("azure");
  it.each(azure.cases.map((c) => [c.name, c] as const))("azure %s", (_n, c) => {
    const findings = evaluateAzure(c.input, { account: c.account!, resourceGroup: c.resourceGroup!, container: c.container!, namespaces: c.namespaces });
    expect(shape(findings)).toEqual(c.expect);
  });

  it("every fixture lists every setting of its store, in order", () => {
    for (const [file, store] of [["s3", "s3"], ["gcs", "gcs"], ["azure", "azblob"]] as const) {
      for (const c of load<unknown>(file).cases) expect(c.expect.map((e) => e.setting)).toEqual([...BUCKET_SETTINGS[store]]);
    }
  });
});

describe("refusedFindings", () => {
  it("honours a waiver except on an unwaivable finding", () => {
    const c = load<S3Input>("s3").cases.find((x) => x.name === "current-expiry-reaches-records")!;
    const settings = evaluateS3({ ...c.input, versioning: {} }, { bucket: "b", namespaces: c.namespaces });
    const report = { store: "s3" as const, bucket: "b", namespaces: c.namespaces, correct: false, settings };
    expect(refusedFindings(report, ["versioning", "lifecycle"]).map((f) => f.setting)).toEqual(["lifecycle"]);
  });
});

describe("S3 XML documents", () => {
  it("reads versioning, the public access block and lifecycle rules", () => {
    expect(parseVersioning(`<?xml version="1.0"?><VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Status>Enabled</Status></VersioningConfiguration>`)).toEqual({ Status: "Enabled" });
    expect(parseVersioning(`<VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"/>`)).toEqual({});
    expect(
      parsePublicAccessBlock(
        `<PublicAccessBlockConfiguration><BlockPublicAcls>true</BlockPublicAcls><IgnorePublicAcls>true</IgnorePublicAcls><BlockPublicPolicy>false</BlockPublicPolicy><RestrictPublicBuckets>true</RestrictPublicBuckets></PublicAccessBlockConfiguration>`,
      ),
    ).toEqual({ PublicAccessBlockConfiguration: { BlockPublicAcls: true, IgnorePublicAcls: true, BlockPublicPolicy: false, RestrictPublicBuckets: true } });
    const lc = parseLifecycle(
      `<LifecycleConfiguration><Rule><ID>records</ID><Filter><Prefix>records/</Prefix></Filter><Status>Enabled</Status><NoncurrentVersionExpiration><NoncurrentDays>30</NoncurrentDays></NoncurrentVersionExpiration></Rule>` +
        `<Rule><ID>tagged</ID><Filter><And><Prefix>x/</Prefix><Tag><Key>k</Key><Value>v</Value></Tag></And></Filter><Status>Enabled</Status><Expiration><Days>7</Days></Expiration></Rule></LifecycleConfiguration>`,
    );
    expect(lc.Rules).toEqual([
      { ID: "records", Status: "Enabled", Filter: { Prefix: "records/" }, NoncurrentVersionExpiration: { NoncurrentDays: 30 } },
      { ID: "tagged", Status: "Enabled", Filter: { And: { Prefix: "x/", Tags: [{ Key: "k", Value: "v" }] } }, Expiration: { Days: 7 } },
    ]);
  });
});

const xml = (status: number, body: string): WireResponse => ({ status, headers: { "content-type": "application/xml" }, body });
const ENDPOINT = "http://localhost:4566";
const CREDS = { accessKeyId: "test", secretAccessKey: "test" };

describe("S3 on the wire", () => {
  it("sends three signed GETs to the emulator only, path style, without asking a chain", async () => {
    const chains = refusingChains();
    const fake = fakeFetcher((call) => {
      const q = new URL(call.url).search;
      if (q === "?versioning") return xml(200, `<VersioningConfiguration><Status>Enabled</Status></VersioningConfiguration>`);
      if (q === "?lifecycle")
        return xml(200, `<LifecycleConfiguration><Rule><ID>r</ID><Filter><Prefix>records/</Prefix></Filter><Status>Enabled</Status><NoncurrentVersionExpiration><NoncurrentDays>30</NoncurrentDays></NoncurrentVersionExpiration></Rule></LifecycleConfiguration>`);
      if (q === "?publicAccessBlock") return xml(404, `<Error><Code>NoSuchPublicAccessBlockConfiguration</Code></Error>`);
      return undefined;
    });
    const report = await checkBucket(
      { store: "s3", bucket: "records-prod", region: "us-east-1", endpoint: ENDPOINT, credentials: CREDS },
      { fetcher: fake.fetcher, chains, now: steppingClock(), namespaces: ["records/prod"] },
    );
    expect(chains.count).toEqual({ aws: 0, azure: 0, gcp: 0 });
    expect(fake.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `GET ${ENDPOINT}/records-prod?versioning`,
      `GET ${ENDPOINT}/records-prod?lifecycle`,
      `GET ${ENDPOINT}/records-prod?publicAccessBlock`,
    ]);
    for (const c of fake.calls) {
      expect(c.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=test\/20261026\/us-east-1\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
      expect(c.headers["x-amz-content-sha256"]).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    }
    expect(report.correct).toBe(false);
    expect(report.settings.map((f) => f.verdict)).toEqual(["ok", "ok", "fail"]);
    expect(report.settings[2]!.fix).toContain("put-public-access-block --bucket records-prod");
  });

  it("refuses an endpoint without static credentials and never asks the default chain", async () => {
    const chains = refusingChains();
    const fake = fakeFetcher(() => undefined);
    await expect(checkBucket({ store: "s3", bucket: "b", region: "us-east-1", endpoint: ENDPOINT }, { fetcher: fake.fetcher, chains })).rejects.toBeInstanceOf(ListerConfigError);
    expect(chains.count.aws).toBe(0);
    expect(fake.calls).toEqual([]);
  });

  it("refuses a bucket that does not exist", async () => {
    const fake = fakeFetcher(() => xml(404, `<Error><Code>NoSuchBucket</Code></Error>`));
    await expect(
      checkBucket({ store: "s3", bucket: "missing", region: "us-east-1", endpoint: ENDPOINT, credentials: CREDS }, { fetcher: fake.fetcher, chains: refusingChains(), now: steppingClock() }),
    ).rejects.toBeInstanceOf(BucketCheckError);
  });

  it("reports a denied read as unreadable and names the owner check", async () => {
    const fake = fakeFetcher(() => xml(403, `<Error><Code>AccessDenied</Code></Error>`));
    const report = await checkBucket(
      { store: "s3", bucket: "b", region: "us-east-1", endpoint: ENDPOINT, credentials: CREDS, expectedOwner: "111122223333" },
      { fetcher: fake.fetcher, chains: refusingChains(), now: steppingClock() },
    );
    expect(report.settings.map((f) => f.verdict)).toEqual(["unreadable", "unreadable", "unreadable"]);
    expect(report.settings[0]!.found).toContain("111122223333");
    expect(fake.calls[0]!.headers["x-amz-expected-bucket-owner"]).toBe("111122223333");
  });
});

describe("GCS on the wire", () => {
  it("reads the bucket resource from the emulator with no token when token is null", async () => {
    const chains = refusingChains();
    const fake = fakeFetcher(() => ({
      status: 200,
      headers: {},
      body: JSON.stringify({
        versioning: { enabled: true },
        lifecycle: { rule: [{ action: { type: "Delete" }, condition: { isLive: false, daysSinceNoncurrentTime: 7 } }] },
        iamConfiguration: { publicAccessPrevention: "enforced", uniformBucketLevelAccess: { enabled: true } },
      }),
    }));
    const report = await checkBucket({ store: "gcs", bucket: "records", endpoint: "http://localhost:4443", token: null }, { fetcher: fake.fetcher, chains });
    expect(chains.count.gcp).toBe(0);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.url).toBe("http://localhost:4443/storage/v1/b/records?projection=noAcl");
    expect(fake.calls[0]!.headers.authorization).toBeUndefined();
    expect(report.correct).toBe(true);
  });

  it("refuses an endpoint without a token", async () => {
    const chains = refusingChains();
    await expect(checkBucket({ store: "gcs", bucket: "records", endpoint: "http://localhost:4443" }, { fetcher: fakeFetcher(() => undefined).fetcher, chains })).rejects.toBeInstanceOf(ListerConfigError);
    expect(chains.count.gcp).toBe(0);
  });
});

describe("Azure on the wire", () => {
  it("reads four ARM documents from the emulator with the given token", async () => {
    const chains = refusingChains();
    const fake = fakeFetcher((call) => {
      const path = new URL(call.url).pathname;
      if (path.endsWith("/managementPolicies/default")) return { status: 404, headers: {}, body: JSON.stringify({ error: { code: "ManagementPolicyNotFound" } }) };
      if (path.endsWith("/containers/tfstate")) return { status: 200, headers: {}, body: JSON.stringify({ properties: { publicAccess: "None" } }) };
      if (path.endsWith("/blobServices/default")) return { status: 200, headers: {}, body: JSON.stringify({ properties: { isVersioningEnabled: true } }) };
      if (path.endsWith("/storageAccounts/stateprod")) return { status: 200, headers: {}, body: JSON.stringify({ properties: { allowBlobPublicAccess: false } }) };
      return undefined;
    });
    const report = await checkBucket(
      { store: "azblob", subscriptionId: "00000000-0000-0000-0000-000000000000", resourceGroup: "state-rg", account: "stateprod", container: "tfstate", endpoint: "http://localhost:4580", token: "fake" },
      { fetcher: fake.fetcher, chains, namespaces: ["records/prod"] },
    );
    expect(chains.count.azure).toBe(0);
    expect(fake.calls.every((c) => c.method === "GET" && c.url.startsWith("http://localhost:4580/subscriptions/") && c.headers.authorization === "Bearer fake")).toBe(true);
    expect(report.bucket).toBe("stateprod/tfstate");
    expect(report.settings.map((f) => f.verdict)).toEqual(["ok", "fail", "ok"]);
    expect(report.settings[1]!.fix).toContain('"prefixMatch":["tfstate/records/prod/"]');
  });
});
