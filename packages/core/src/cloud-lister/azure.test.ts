/**
 * behold#1029: the Azure lister against a fake Resource Graph. Shapes follow
 * the pinned floci-az's docs/services/resource-graph.md (source 7f079c2):
 * `{ totalRecords, count, data, facets, resultTruncated }`, `$skipToken`
 * for the next page, `type` lowercase.
 */
import { describe, expect, it } from "vitest";
import { listCloud } from "./index";
import { resourceGraphQuery } from "./azure";
import { ListerConfigError } from "./credentials";
import { MASKED } from "./mask";
import { fakeFetcher, json, refusingChains, steppingClock } from "./fakes";

const SUB = "00000000-0000-0000-0000-000000000001";
const ENDPOINT = "https://localhost:4577";
const ID_A = `/subscriptions/${SUB}/resourceGroups/RG-Web/providers/Microsoft.Storage/storageAccounts/webassets`;
const ID_B = `/subscriptions/${SUB}/resourceGroups/rg-web/providers/Microsoft.KeyVault/vaults/kv1`;

describe("the Resource Graph query", () => {
  it("narrows by type, location and tag, and orders by id", () => {
    const q = resourceGraphQuery({
      substrate: "azure",
      scopeId: SUB,
      types: ["microsoft.storage/storageaccounts"],
      locations: ["eastus"],
      tagFilter: { "tofu-estate": "web" },
    });
    expect(q).toBe(
      [
        "Resources",
        "| where type in~ ('microsoft.storage/storageaccounts')",
        "| where location in~ ('eastus')",
        "| where tags['tofu-estate'] == 'web'",
        "| project id, name, type, kind, location, resourceGroup, subscriptionId, managedBy, tags, sku, plan, identity, zones, extendedLocation, properties",
        "| order by id asc",
      ].join("\n"),
    );
  });

  it("adds resource groups for every type", () => {
    expect(resourceGraphQuery({ substrate: "azure", scopeId: SUB, types: "*", locations: "*" }).split("\n")[0]).toBe(
      "Resources | union (ResourceContainers | where type =~ 'microsoft.resources/subscriptions/resourcegroups')",
    );
  });

  it("refuses a value that could change the query", () => {
    expect(() => resourceGraphQuery({ substrate: "azure", scopeId: SUB, types: ["x') | union (Secrets"], locations: "*" })).toThrow(ListerConfigError);
  });
});

describe("listing azure", () => {
  it("pages and fills the listing-result shape", async () => {
    const fake = fakeFetcher((call) => {
      const body = JSON.parse(call.body ?? "{}");
      expect(body.subscriptions).toEqual([SUB]);
      if (!body.options.$skipToken) {
        return json(200, {
          totalRecords: 2,
          count: 1,
          data: [{ id: ID_A, name: "webassets", type: "microsoft.storage/storageaccounts", location: "eastus", tags: { "chant-managed-by": "chant", "chant-stack": "web" }, properties: { primaryEndpoints: {} } }],
          $skipToken: "1",
        });
      }
      return json(200, {
        totalRecords: 2,
        count: 1,
        data: [{ id: ID_B, name: "kv1", type: "microsoft.keyvault/vaults", location: "EastUS", tags: {}, properties: { adminPassword: "p@ss", connectionString: "Server=x" } }],
      });
    });
    const result = await listCloud(
      { substrate: "azure", scopeId: SUB, types: "*", locations: "*" },
      { substrate: "azure", azure: { endpoint: ENDPOINT, token: "static-token" } },
      { fetcher: fake.fetcher, chains: refusingChains(), now: steppingClock(), retryDelays: [] },
    );
    expect(fake.calls.length).toBe(2);
    expect(fake.calls[0].url).toBe(`${ENDPOINT}/providers/Microsoft.ResourceGraph/resources?api-version=2022-10-01`);
    expect(fake.calls[0].headers.authorization).toBe("Bearer static-token");

    const sa = result.resources.find((r) => r.nativeId === ID_A)!;
    expect(sa.id).toBe(`azure/${SUB}/eastus/microsoft.storage%2Fstorageaccounts/${ID_A}`);
    expect(sa.cloudIds).toEqual([
      { kind: "provider-id", value: ID_A },
      { kind: "provider-id", value: ID_A.toLowerCase() },
    ]);
    expect(sa.facts.markers).toEqual({ owner: "web", encoding: "plain", source: "live" });
    expect(sa.properties).not.toHaveProperty("tags");

    const kv = result.resources.find((r) => r.nativeId === ID_B)!;
    expect(kv.location).toBe("eastus");
    expect((kv.properties.properties as Record<string, unknown>).adminPassword).toBe(MASKED);
    expect((kv.properties.properties as Record<string, unknown>).connectionString).toBe(MASKED);

    expect(result.coverage).toEqual([{ listedType: "*", location: "*", verdict: "listed" }]);
  });

  it("covers each named type and location", async () => {
    const fake = fakeFetcher(() => json(200, { data: [] }));
    const result = await listCloud(
      { substrate: "azure", scopeId: SUB, types: ["Microsoft.Storage/storageAccounts", "microsoft.keyvault/vaults"], locations: ["westus", "eastus"] },
      { substrate: "azure", azure: { endpoint: ENDPOINT, token: "t" } },
      { fetcher: fake.fetcher, chains: refusingChains(), now: steppingClock(), retryDelays: [] },
    );
    expect(result.coverage.map((c) => `${c.listedType}@${c.location}:${c.verdict}`)).toEqual([
      "microsoft.keyvault/vaults@eastus:listed",
      "microsoft.keyvault/vaults@westus:listed",
      "microsoft.storage/storageaccounts@eastus:listed",
      "microsoft.storage/storageaccounts@westus:listed",
    ]);
  });

  it("reports a refused token as no-credentials", async () => {
    const fake = fakeFetcher(() => json(401, { error: { code: "InvalidAuthenticationToken", message: "The access token is invalid." } }));
    const result = await listCloud(
      { substrate: "azure", scopeId: SUB, types: "*", locations: "*" },
      { substrate: "azure", azure: { endpoint: ENDPOINT, token: "bad" } },
      { fetcher: fake.fetcher, chains: refusingChains(), now: steppingClock(), retryDelays: [] },
    );
    expect(result.resources).toEqual([]);
    expect(result.coverage).toEqual([{ listedType: "*", location: "*", verdict: "no-credentials", detail: "HTTP 401: InvalidAuthenticationToken: The access token is invalid." }]);
    expect(result.notes[0].code).toBe("no-credentials");
  });

  it("never asks DefaultAzureCredential when an endpoint is given", async () => {
    const chains = refusingChains();
    const fake = fakeFetcher(() => undefined);
    await expect(
      listCloud({ substrate: "azure", scopeId: SUB, types: "*", locations: "*" }, { substrate: "azure", azure: { endpoint: ENDPOINT } }, { fetcher: fake.fetcher, chains }),
    ).rejects.toThrow(/needs a static bearer token/);
    expect(chains.count.azure).toBe(0);
    expect(fake.calls).toEqual([]);
  });
});
