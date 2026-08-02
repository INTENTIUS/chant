/**
 * Azure deep observation (#1086) — the azure row of the deep-observe
 * contract (#1014).
 *
 * The transport is faked, exactly like describe-resources.test.ts (#1212) — no
 * CLI, no ARM SDK, no ambient `az login` session, nothing reaches a network.
 * `http` is injected where the reader is called directly, and `fetch` is
 * stubbed where the plugin builds its own client.
 */
import { describe, test, expect, vi, afterEach } from "vitest";

/** For the paths that go through the plugin, which builds its own transport. */
const stubArmFetch = (response: { status: number; text: string }): void => {
  vi.spyOn(globalThis, "fetch").mockImplementation((async () => ({
    status: response.status,
    text: () => Promise.resolve(response.text),
  })) as unknown as typeof fetch);
};

const { azurePlugin } = await import("./plugin");
const { observeResourcesDeepAzure, azureDeepNormalizationHooks } = await import("./deep-observe");
const { deepDiffForLexicon } = await import("@intentius/chant/lifecycle/deep-observe");
const { normalizeDeepObservation, normalizeDeepProperties } = await import("@intentius/chant/deep-observation");

/** An ARM 200, in place of the CLI stdout this used to fake (#1212). */
const ok = (body: Record<string, unknown>) => ({ status: 200, text: JSON.stringify(body) });
/** ARM's error envelope — the code is the signal, not the prose. */
const armError = (status: number, code: string, message = code) => ({
  status,
  text: JSON.stringify({ error: { code, message } }),
});

/** Routes by the resource name in the ARM URL, which is where it lives now. */
function armFake(route: (name: string) => { status: number; text: string }) {
  const urls: string[] = [];
  const http = async (_method: string, url: string) => {
    urls.push(url);
    const name = decodeURIComponent(url.split("?")[0].split("/").pop() ?? "");
    return route(name);
  };
  return { http, urls };
}

const entities = (
  record: Record<string, { entityType: string; props: Record<string, unknown> }>,
): Map<string, { entityType: string; props: Record<string, unknown> }> => new Map(Object.entries(record));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the azure noise rules", () => {
  test("prunes server-populated names wherever they appear", () => {
    const out = normalizeDeepProperties(
      {
        name: "acct",
        resourceGuid: "11111111-2222-3333-4444-555555555555",
        properties: { provisioningState: "Succeeded", nested: { provisioningState: "Succeeded", keep: 1 } },
        identity: { type: "SystemAssigned", principalId: "guid-1", tenantId: "guid-2" },
      },
      { entityType: "Microsoft.Storage/storageAccounts", side: "live", hooks: azureDeepNormalizationHooks },
    );
    expect(out).toEqual({
      name: "acct",
      properties: { nested: { keep: 1 } },
      identity: { type: "SystemAssigned" },
    });
  });

  test("prunes defaultSecurityRules unconditionally — server boilerplate nobody declares", () => {
    const out = normalizeDeepProperties(
      { securityRules: [{ name: "allow-ssh", priority: 100 }], defaultSecurityRules: [{ name: "AllowVnetInBound" }] },
      { entityType: "Microsoft.Network/networkSecurityGroups", side: "live", hooks: azureDeepNormalizationHooks },
    );
    expect(out).toEqual({ securityRules: [{ name: "allow-ssh", priority: 100 }] });
  });

  test("subtracts an empty tag map only where source declares no tags at all", () => {
    const declaredNothing = normalizeDeepProperties(
      { name: "acct", tags: {} },
      { entityType: "Microsoft.Storage/storageAccounts", side: "live", hooks: azureDeepNormalizationHooks, counterpartPaths: new Set(["name"]) },
    );
    expect(declaredNothing).toEqual({ name: "acct" });

    const declaredTags = normalizeDeepProperties(
      { name: "acct", tags: {} },
      { entityType: "Microsoft.Storage/storageAccounts", side: "live", hooks: azureDeepNormalizationHooks, counterpartPaths: new Set(["name", "tags"]) },
    );
    expect(declaredTags).toEqual({ name: "acct", tags: {} });
  });

  test("subtracts a per-type service default only where source is silent about the property", () => {
    const declaredNothing = normalizeDeepProperties(
      { name: "acct", minimumTlsVersion: "TLS1_2" },
      { entityType: "Microsoft.Storage/storageAccounts", side: "live", hooks: azureDeepNormalizationHooks, counterpartPaths: new Set(["name"]) },
    );
    expect(declaredNothing).toEqual({ name: "acct" });

    const declaredIt = normalizeDeepProperties(
      { name: "acct", minimumTlsVersion: "TLS1_2" },
      { entityType: "Microsoft.Storage/storageAccounts", side: "live", hooks: azureDeepNormalizationHooks, counterpartPaths: new Set(["name", "minimumTlsVersion"]) },
    );
    expect(declaredIt).toEqual({ name: "acct", minimumTlsVersion: "TLS1_2" });
  });

  test("a one-sided pass never subtracts defaults or the empty tag map — the reader has no declared tree yet", () => {
    const out = normalizeDeepProperties(
      { name: "acct", tags: {}, minimumTlsVersion: "TLS1_2" },
      { entityType: "Microsoft.Storage/storageAccounts", side: "live", hooks: azureDeepNormalizationHooks },
    );
    expect(out).toEqual({ name: "acct", tags: {}, minimumTlsVersion: "TLS1_2" });
  });

  test("canonicalizes a named rule array by its name field", () => {
    const out = normalizeDeepProperties(
      { securityRules: [{ name: "deny-all", priority: 200 }, { name: "allow-ssh", priority: 100 }] },
      { entityType: "Microsoft.Network/networkSecurityGroups", side: "live", hooks: azureDeepNormalizationHooks },
    );
    expect((out.securityRules as Array<{ name: string }>).map((r) => r.name)).toEqual(["allow-ssh", "deny-all"]);
  });

  test("canonicalizes a primitive-valued set by value, nested under any depth", () => {
    const out = normalizeDeepProperties(
      { addressSpace: { addressPrefixes: ["10.1.0.0/16", "10.0.0.0/16"] } },
      { entityType: "Microsoft.Network/virtualNetworks", side: "live", hooks: azureDeepNormalizationHooks },
    );
    expect((out.addressSpace as { addressPrefixes: string[] }).addressPrefixes).toEqual(["10.0.0.0/16", "10.1.0.0/16"]);
  });

  test("leaves an array not on the known-set list in source order", () => {
    const out = normalizeDeepProperties(
      { routes: [{ name: "z" }, { name: "a" }] },
      { entityType: "Microsoft.Network/routeTables", side: "live", hooks: azureDeepNormalizationHooks },
    );
    expect((out.routes as Array<{ name: string }>).map((r) => r.name)).toEqual(["z", "a"]);
  });
});

describe("observeResourcesDeepAzure", () => {
  test("reads the resource over ARM and flattens properties.* onto the top level", async () => {
    const fake = armFake(() =>
      ok({
        id: "/subscriptions/sub/resourceGroups/prod-rg/providers/Microsoft.Storage/storageAccounts/mydata",
        name: "mydata",
        type: "Microsoft.Storage/storageAccounts",
        location: "eastus",
        tags: { env: "prod" },
        etag: "\"abc\"",
        systemData: { createdBy: "someone@example.com" },
        properties: { provisioningState: "Succeeded", minimumTlsVersion: "TLS1_2", allowBlobPublicAccess: false },
      }),
    );

    const result = normalizeDeepObservation(
      await observeResourcesDeepAzure({
        environment: "prod-rg",
        entityNames: ["dataAccount"],
        entities: entities({ dataAccount: { entityType: "Microsoft.Storage/storageAccounts", props: { name: "mydata" } } }),
        http: fake.http,
      }),
    );

    expect(fake.urls[0]).toContain("/resourceGroups/prod-rg/");
    expect(fake.urls[0]).toContain("/providers/Microsoft.Storage/storageAccounts/mydata");

    // id/type/etag/systemData/provisioningState never reach the tree at all —
    // no declared tree yet, so this is what a one-sided read looks like.
    expect(result.resources.dataAccount).toEqual({
      type: "Microsoft.Storage/storageAccounts",
      physicalId: "/subscriptions/sub/resourceGroups/prod-rg/providers/Microsoft.Storage/storageAccounts/mydata",
      properties: { name: "mydata", location: "eastus", tags: { env: "prod" }, minimumTlsVersion: "TLS1_2", allowBlobPublicAccess: false },
    });
  });

  test("a resource not found leaves the entity out — a confirmed absence", async () => {
    const fake = armFake(() => armError(404, "ResourceNotFound", "not found"));
    const result = normalizeDeepObservation(
      await observeResourcesDeepAzure({
        environment: "prod-rg",
        entityNames: ["missing"],
        entities: entities({ missing: { entityType: "Microsoft.Storage/storageAccounts", props: { name: "missing" } } }),
        http: fake.http,
      }),
    );
    expect(result).toEqual({ resources: {}, unobserved: {} });
  });

  test("a refused credential is a hole, not an absence", async () => {
    const fake = armFake(() => armError(401, "AuthenticationFailed", "Authentication failed."));
    const result = normalizeDeepObservation(
      await observeResourcesDeepAzure({
        environment: "prod-rg",
        entityNames: ["acct"],
        entities: entities({ acct: { entityType: "Microsoft.Storage/storageAccounts", props: { name: "acct" } } }),
        http: fake.http,
      }),
    );
    expect(result.resources).toEqual({});
    expect(result.unobserved.acct.reason).toBe("no-credentials");
  });

  test("a nested ARM type is unsupported-kind, never absent — az resource show is never called", async () => {
    const fake = armFake(() => ok({}));
    const result = normalizeDeepObservation(
      await observeResourcesDeepAzure({
        environment: "prod-rg",
        entityNames: ["nested"],
        entities: entities({ nested: { entityType: "Microsoft.Storage/storageAccounts/blobServices", props: { name: "default" } } }),
        http: fake.http,
      }),
    );
    expect(result.resources).toEqual({});
    expect(result.unobserved.nested.reason).toBe("unsupported-kind");
    expect(fake.urls).toEqual([]);
  });

  test("a non-ARM entity type is unsupported-kind — no ARM type to query", async () => {
    const fake = armFake(() => ok({}));
    const result = normalizeDeepObservation(
      await observeResourcesDeepAzure({
        environment: "prod-rg",
        entityNames: ["x"],
        entities: entities({ x: { entityType: "AWS::S3::Bucket", props: { name: "x" } } }),
        http: fake.http,
      }),
    );
    expect(result.unobserved.x.reason).toBe("unsupported-kind");
    expect(fake.urls).toEqual([]);
  });

  test("an entity with no name is a hole — nothing was queried", async () => {
    const fake = armFake(() => ok({}));
    const result = normalizeDeepObservation(
      await observeResourcesDeepAzure({
        environment: "prod-rg",
        entityNames: ["broken"],
        entities: entities({ broken: { entityType: "Microsoft.Storage/storageAccounts", props: {} } }),
        http: fake.http,
      }),
    );
    expect(result.unobserved.broken.reason).toBe("read-failed");
    expect(fake.urls).toEqual([]);
  });
});

/**
 * The acceptance test for #1086: the real plugin, a mutated live resource
 * group, a baseline, and exactly the genuine drift — same shape as the AWS
 * reference's end-to-end test.
 */
describe("end to end: declared + mutated live + baseline (#1086)", () => {
  const declared = entities({
    // Declared with TLS enforced, public blob access off, one tag.
    dataAccount: {
      entityType: "Microsoft.Storage/storageAccounts",
      props: { name: "mydata", location: "eastus", tags: { env: "prod" }, minimumTlsVersion: "TLS1_2", allowBlobPublicAccess: false },
    },
    // Declared with two address prefixes, in source order.
    vnet: {
      entityType: "Microsoft.Network/virtualNetworks",
      props: { name: "core-vnet", location: "eastus", addressSpace: { addressPrefixes: ["10.0.0.0/16", "10.1.0.0/16"] } },
    },
    // No reader for a nested ARM type.
    blobServices: { entityType: "Microsoft.Storage/storageAccounts/blobServices", props: { name: "default" } },
    // The deep read of this one fails outright.
    secureAcct: { entityType: "Microsoft.Storage/storageAccounts", props: { name: "secure-acct" } },
  });

  const wireMocks = (): void => {
    vi.spyOn(globalThis, "fetch").mockImplementation((async (url: string) => {
      const name = decodeURIComponent(url.split("?")[0].split("/").pop() ?? "");
      const respond = (r: { status: number; text: string }) =>
        ({ status: r.status, text: () => Promise.resolve(r.text) });
      if (name === "mydata") {
        return respond(ok({
          id: "/subscriptions/sub/resourceGroups/prod/providers/Microsoft.Storage/storageAccounts/mydata",
          name: "mydata",
          location: "eastus",
          etag: "\"abc\"",
          // NOISE: an out-of-band tag the platform team adds to every bucket.
          tags: { env: "prod", "cost-center": "platform" },
          properties: {
            // NOISE: server-populated.
            provisioningState: "Succeeded",
            resourceGuid: "11111111-2222-3333-4444-555555555555",
            // NOISE: matches the declared value, so no drift either way.
            minimumTlsVersion: "TLS1_2",
            // GENUINE: somebody flipped this in the portal.
            allowBlobPublicAccess: true,
          },
        }));
      }
      if (name === "core-vnet") {
        return respond(ok({
          id: "/subscriptions/sub/resourceGroups/prod/providers/Microsoft.Network/virtualNetworks/core-vnet",
          name: "core-vnet",
          location: "eastus",
          properties: {
            provisioningState: "Succeeded",
            resourceGuid: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
            // NOISE: same two prefixes, different order.
            addressSpace: { addressPrefixes: ["10.1.0.0/16", "10.0.0.0/16"] },
          },
        }));
      }
      if (name === "secure-acct") {
        return respond(armError(401, "AuthenticationFailed", "Authentication failed."));
      }
      return respond(armError(400, "BadRequest", `unexpected call for ${name}`));
    }) as unknown as typeof fetch);
  };

  const baseline = {
    dataAccount: {
      type: "Microsoft.Storage/storageAccounts",
      accepted: [{ path: "tags.cost-center", value: "platform" }],
    },
  };

  test("exactly the genuine drift surfaces; noise, defaults and the accepted tag do not", async () => {
    wireMocks();
    const result = await deepDiffForLexicon(azurePlugin, {
      environment: "prod",
      buildOutput: "",
      entities: declared,
      baseline,
    });

    // One finding, one property: the console-flipped public-access setting.
    expect(result.drifted).toEqual([
      {
        name: "dataAccount",
        type: "Microsoft.Storage/storageAccounts",
        changes: [{ path: "allowBlobPublicAccess", kind: "changed", declared: false, live: true }],
      },
    ]);

    // The vnet is clean: reordering and server-populated fields subtract.
    expect(result.unchanged).toEqual(["vnet"]);

    // The platform team's tag is accepted, so it is reported as suppressed
    // rather than as drift.
    expect(result.accepted.map((e) => e.name)).toEqual(["dataAccount"]);
    expect(result.accepted[0].changes.map((c) => c.path)).toEqual(["tags.cost-center"]);

    // An unreadable deep read is a hole with a reason — never silence, never
    // noise, and never a create.
    expect(result.unobserved).toEqual([
      {
        name: "blobServices",
        type: "Microsoft.Storage/storageAccounts/blobServices",
        reason: "unsupported-kind",
        detail: "a nested ARM type needs a different read path; chant never queried this resource",
      },
      { name: "secureAcct", type: "Microsoft.Storage/storageAccounts", reason: "no-credentials", detail: "AuthenticationFailed: Authentication failed." },
    ]);
  });

  test("without the baseline the platform tag is drift, and accepting it is what silences it", async () => {
    wireMocks();
    const result = await deepDiffForLexicon(azurePlugin, { environment: "prod", buildOutput: "", entities: declared });
    const dataAccount = result.drifted.find((d) => d.name === "dataAccount");
    expect(dataAccount?.changes.map((c) => c.path).sort()).toEqual(["allowBlobPublicAccess", "tags.cost-center"]);
    expect(result.accepted).toEqual([]);
  });

  test("an accepted value that later changes is drift again, with all three axes", async () => {
    wireMocks();
    const result = await deepDiffForLexicon(azurePlugin, {
      environment: "prod",
      buildOutput: "",
      entities: declared,
      baseline: { dataAccount: { accepted: [{ path: "tags.cost-center", value: "someone-elses-team" }] } },
    });
    const change = result.drifted.find((d) => d.name === "dataAccount")?.changes.find((c) => c.path === "tags.cost-center");
    expect(change).toEqual({ path: "tags.cost-center", kind: "undeclared", live: "platform", baseline: "someone-elses-team" });
  });

  test("a whole-lexicon failure is a hole for every declared entity, not a clean report", async () => {
    stubArmFetch(armError(401, "AuthenticationFailed", "Authentication failed."));
    const result = await deepDiffForLexicon(azurePlugin, { environment: "prod", buildOutput: "", entities: declared });
    expect(result.drifted).toEqual([]);
    // blobServices is still unsupported-kind — it is never addressed at all, so
    // a refused transport doesn't change its verdict.
    expect(result.unobserved.map((u) => u.name).sort()).toEqual(["blobServices", "dataAccount", "secureAcct", "vnet"]);
    expect(result.unobserved.find((u) => u.name === "blobServices")?.reason).toBe("unsupported-kind");
    // `no-credentials`, not the `read-failed` the CLI path reported: ARM sends
    // `AuthenticationFailed` as a code, where the CLI's prose ("Unable to
    // locate credentials") matched none of the patterns and fell through to the
    // generic verdict. The code makes the credential case legible (#1212).
    expect(
      result.unobserved.filter((u) => u.name !== "blobServices").every((u) => u.reason === "no-credentials"),
    ).toBe(true);
  });
});
