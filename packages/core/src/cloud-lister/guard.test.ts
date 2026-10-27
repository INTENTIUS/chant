/**
 * behold#1029 done-when: "A test fails if any mutating API is reachable from
 * the lister."
 *
 * Three layers, each of which goes red when a mutating call is added:
 *  1. the allowlist is pinned to exactly the five read operations, and no
 *     entry may name a write;
 *  2. a mutating call of every kind each substrate has is refused by the
 *     guard, and never reaches the fetcher;
 *  3. every call each lister makes while listing (against fakes) classifies
 *     into the allowlist, and the lister sources name no mutating operation.
 *
 * Red first: add `"cloudcontrol:CreateResource"` to READ_OPERATIONS.aws, or a
 * `method: "PUT"` call to any lister, and layer 1 or 3 fails.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { assertReadCall, classifyCall, MutatingCallRefused, READ_OPERATIONS, type WireCall } from "./guard";
import { Transport, OriginRefused } from "./transport";
import { listCloud } from "./index";
import { fakeFetcher, json, refusingChains, steppingClock } from "./fakes";

const here = dirname(fileURLToPath(import.meta.url));

describe("the read allowlist", () => {
  it("is exactly the five read operations", () => {
    expect(READ_OPERATIONS).toEqual({
      aws: ["cloudcontrol:ListResources"],
      azure: ["resourcegraph:resources"],
      gcp: ["cloudasset:searchAllResources"],
      kubernetes: ["k8s:discovery", "k8s:list"],
    });
  });

  it("names no write", () => {
    for (const ops of Object.values(READ_OPERATIONS)) {
      for (const op of ops) expect(op).not.toMatch(/create|update|delete|put|patch|enable|disable|cancel|watch|tag|apply|import|export/i);
    }
  });
});

const aws = (target: string, method: WireCall["method"] = "POST"): WireCall => ({
  substrate: "aws",
  method,
  url: "http://localhost:4566/",
  headers: { "x-amz-target": `CloudApiService.${target}` },
  body: "{}",
});

const MUTATING: Array<[string, WireCall]> = [
  ["aws CreateResource", aws("CreateResource")],
  ["aws UpdateResource", aws("UpdateResource")],
  ["aws DeleteResource", aws("DeleteResource")],
  ["aws CancelResourceRequest", aws("CancelResourceRequest")],
  ["aws GetResource (not on the list either)", aws("GetResource")],
  ["aws a call with no target", { substrate: "aws", method: "POST", url: "http://localhost:4566/", headers: {}, body: "Action=CreateBucket" }],
  ["aws a PUT", { substrate: "aws", method: "PUT", url: "http://localhost:4566/bucket", headers: {} }],
  ["azure PUT on an ARM resource", { substrate: "azure", method: "PUT", url: "https://localhost:4577/subscriptions/s/resourceGroups/rg?api-version=2021-04-01", headers: {} }],
  ["azure DELETE on an ARM resource", { substrate: "azure", method: "DELETE", url: "https://localhost:4577/subscriptions/s/resourceGroups/rg?api-version=2021-04-01", headers: {} }],
  ["azure POST to another provider action", { substrate: "azure", method: "POST", url: "https://localhost:4577/subscriptions/s/providers/Microsoft.Storage/register?api-version=2021-04-01", headers: {} }],
  ["azure GET on Resource Graph's path", { substrate: "azure", method: "GET", url: "https://localhost:4577/providers/Microsoft.ResourceGraph/resources", headers: {} }],
  ["gcp enabling the Cloud Asset API", { substrate: "gcp", method: "POST", url: "https://serviceusage.googleapis.com/v1/projects/p/services/cloudasset.googleapis.com:enable", headers: {} }],
  ["gcp batchEnable", { substrate: "gcp", method: "POST", url: "https://serviceusage.googleapis.com/v1/projects/p/services:batchEnable", headers: {} }],
  ["gcp a searchAllResources on the serviceusage host", { substrate: "gcp", method: "GET", url: "https://serviceusage.googleapis.com/v1/projects/p:searchAllResources", headers: {} }],
  ["gcp POST searchAllResources", { substrate: "gcp", method: "POST", url: "http://localhost:4588/cloudasset/v1/projects/p:searchAllResources", headers: {} }],
  ["gcp creating a feed", { substrate: "gcp", method: "POST", url: "https://cloudasset.googleapis.com/v1/projects/p/feeds", headers: {} }],
  ["gcp exportAssets", { substrate: "gcp", method: "GET", url: "https://cloudasset.googleapis.com/v1/projects/p:exportAssets", headers: {} }],
  ["k8s POST", { substrate: "kubernetes", method: "POST", url: "https://127.0.0.1:6443/api/v1/namespaces/default/pods", headers: {} }],
  ["k8s PUT", { substrate: "kubernetes", method: "PUT", url: "https://127.0.0.1:6443/api/v1/namespaces/default/configmaps/x", headers: {} }],
  ["k8s PATCH", { substrate: "kubernetes", method: "PATCH", url: "https://127.0.0.1:6443/apis/apps/v1/namespaces/default/deployments/x", headers: {} }],
  ["k8s DELETE", { substrate: "kubernetes", method: "DELETE", url: "https://127.0.0.1:6443/api/v1/namespaces/default/pods/x", headers: {} }],
  ["k8s a watch", { substrate: "kubernetes", method: "GET", url: "https://127.0.0.1:6443/api/v1/pods?watch=1", headers: {} }],
  ["k8s a pod's exec", { substrate: "kubernetes", method: "GET", url: "https://127.0.0.1:6443/api/v1/namespaces/default/pods/x/exec?command=sh", headers: {} }],
  ["k8s a service proxy", { substrate: "kubernetes", method: "GET", url: "https://127.0.0.1:6443/api/v1/namespaces/default/services/x/proxy/", headers: {} }],
];

describe("the guard refuses every mutating call", () => {
  for (const [name, call] of MUTATING) {
    it(name, async () => {
      expect(() => assertReadCall(call)).toThrow(MutatingCallRefused);
      const fake = fakeFetcher(() => json(200, {}));
      const transport = new Transport({ fetcher: fake.fetcher });
      await expect(transport.send(call)).rejects.toThrow(MutatingCallRefused);
      expect(fake.calls).toEqual([]);
    });
  }

  it("admits the four reads", () => {
    expect(classifyCall(aws("ListResources"))).toBe("cloudcontrol:ListResources");
    expect(classifyCall({ substrate: "azure", method: "POST", url: "https://management.azure.com/providers/Microsoft.ResourceGraph/resources?api-version=2022-10-01", headers: {} })).toBe("resourcegraph:resources");
    expect(classifyCall({ substrate: "gcp", method: "GET", url: "http://localhost:4588/cloudasset/v1/projects/p:searchAllResources?pageSize=500", headers: {} })).toBe("cloudasset:searchAllResources");
    expect(classifyCall({ substrate: "kubernetes", method: "GET", url: "https://h/apis/apps/v1", headers: {} })).toBe("k8s:discovery");
    expect(classifyCall({ substrate: "kubernetes", method: "GET", url: "https://h/apis/apps/v1/deployments?limit=500", headers: {} })).toBe("k8s:list");
  });
});

describe("the origin pin", () => {
  it("refuses a call to any host but the run's endpoint", async () => {
    const fake = fakeFetcher(() => json(200, {}));
    const transport = new Transport({ fetcher: fake.fetcher, pinnedOrigin: "http://localhost:4566" });
    await expect(transport.send({ ...aws("ListResources"), url: "https://cloudcontrolapi.us-east-1.amazonaws.com/" })).rejects.toThrow(OriginRefused);
    expect(fake.calls).toEqual([]);
  });
});

describe("every call a lister makes is on the allowlist", () => {
  const seen: Array<{ substrate: string; operation: string }> = [];
  const onSend = (call: WireCall, operation: string) => seen.push({ substrate: call.substrate, operation });

  it("aws", async () => {
    const fake = fakeFetcher(() => json(200, { TypeName: "AWS::S3::Bucket", ResourceDescriptions: [] }));
    await listCloud(
      { substrate: "aws", scopeId: "000000000000", locations: ["us-east-1"], types: ["AWS::S3::Bucket", "AWS::IAM::Role"] },
      { substrate: "aws", aws: { endpoint: "http://localhost:4566", credentials: { accessKeyId: "test", secretAccessKey: "test" } } },
      { fetcher: fake.fetcher, chains: refusingChains(), now: steppingClock(), retryDelays: [], onSend },
    );
    expect(fake.calls.length).toBe(2);
  });

  it("azure", async () => {
    const fake = fakeFetcher(() => json(200, { data: [], totalRecords: 0, count: 0 }));
    await listCloud(
      { substrate: "azure", scopeId: "00000000-0000-0000-0000-000000000000", locations: "*", types: "*" },
      { substrate: "azure", azure: { endpoint: "https://localhost:4577", token: "static" } },
      { fetcher: fake.fetcher, chains: refusingChains(), now: steppingClock(), retryDelays: [], onSend },
    );
    expect(fake.calls.length).toBe(1);
  });

  it("gcp", async () => {
    const fake = fakeFetcher(() => json(200, {}));
    await listCloud(
      { substrate: "gcp", scopeId: "plc-corpus", locations: "*", types: "*" },
      { substrate: "gcp", gcp: { endpoint: "http://localhost:4588/cloudasset", token: null } },
      { fetcher: fake.fetcher, chains: refusingChains(), now: steppingClock(), retryDelays: [], onSend },
    );
    expect(fake.calls.length).toBe(1);
  });

  it("kubernetes", async () => {
    const fake = fakeFetcher((call) => {
      const path = new URL(call.url).pathname;
      if (path === "/api/v1") return json(200, { resources: [{ name: "configmaps", kind: "ConfigMap", namespaced: true, verbs: ["get", "list", "create"] }] });
      if (path === "/apis") return json(200, { groups: [] });
      if (path === "/api/v1/configmaps") return json(200, { items: [] });
      return undefined;
    });
    await listCloud(
      { substrate: "kubernetes", scopeId: "kind-floci", locations: "*", types: "*" },
      { substrate: "kubernetes", kubernetes: { server: "https://127.0.0.1:6443", token: "static" } },
      { fetcher: fake.fetcher, chains: refusingChains(), now: steppingClock(), retryDelays: [], onSend },
    );
    expect(fake.calls.length).toBe(3);
  });

  it("and nothing else", () => {
    for (const { substrate, operation } of seen) {
      expect(READ_OPERATIONS[substrate as keyof typeof READ_OPERATIONS]).toContain(operation);
    }
    expect(new Set(seen.map((s) => s.operation))).toEqual(
      new Set(["cloudcontrol:ListResources", "resourcegraph:resources", "cloudasset:searchAllResources", "k8s:discovery", "k8s:list"]),
    );
  });
});

describe("the lister sources", () => {
  const sources = readdirSync(here).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== "guard.ts" && f !== "fakes.ts");

  it("include every substrate's lister", () => {
    expect(sources).toEqual(expect.arrayContaining(["aws.ts", "azure.ts", "gcp.ts", "kubernetes.ts", "transport.ts"]));
  });

  it("send only GET and POST", () => {
    for (const f of sources) {
      const text = readFileSync(join(here, f), "utf8");
      expect(text, f).not.toMatch(/method:\s*"(PUT|PATCH|DELETE)"/);
    }
  });

  it("name no mutating Cloud Control, Service Usage or Cloud Asset operation", () => {
    for (const f of sources) {
      const text = readFileSync(join(here, f), "utf8");
      const targets = [...text.matchAll(/CloudApiService\.([A-Za-z]+)/g)].map((m) => m[1]);
      for (const t of targets) expect(t, f).toBe("ListResources");
      expect(text, f).not.toMatch(/:(enable|disable|batchEnable|exportAssets)\b|\/feeds\b/);
      expect(text, f).not.toMatch(/serviceusage\.googleapis\.com/);
    }
  });

  it("import no cloud SDK client", () => {
    for (const f of sources) {
      const text = readFileSync(join(here, f), "utf8");
      expect(text, f).not.toMatch(/from\s+"@aws-sdk\/client-|from\s+"@azure\/arm-|from\s+"@google-cloud\/|from\s+"@kubernetes\/client-node"|from\s+"@intentius\/chant-k8s-client"/);
    }
  });
});
