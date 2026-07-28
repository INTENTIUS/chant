/**
 * Azure deep observation (#1086) — the azure row of the deep-observe
 * contract (#1014).
 *
 * `node:child_process`'s `exec` is mocked, exactly like
 * describe-resources.test.ts — no ARM SDK, no ambient `az login` session,
 * nothing reaches a network.
 */
import { describe, test, expect, vi, beforeEach } from "vitest";

const execMock = vi.fn();
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    exec: (cmd: string, cb: (err: Error | null, out: { stdout: string; stderr: string }) => void) => {
      Promise.resolve(execMock(cmd)).then(
        (out) => cb(null, out as { stdout: string; stderr: string }),
        (err) => cb(err as Error, { stdout: "", stderr: "" }),
      );
    },
  };
});

const { azurePlugin } = await import("./plugin");
const { observeResourcesDeepAzure, azureDeepNormalizationHooks } = await import("./deep-observe");
const { deepDiffForLexicon } = await import("@intentius/chant/lifecycle/deep-observe");
const { normalizeDeepObservation, normalizeDeepProperties } = await import("@intentius/chant/deep-observation");

const ok = (body: Record<string, unknown>) => Promise.resolve({ stdout: JSON.stringify(body), stderr: "" });
const fail = (stderr: string) => Promise.reject(Object.assign(new Error("az failed"), { stderr }));

const entities = (
  record: Record<string, { entityType: string; props: Record<string, unknown> }>,
): Map<string, { entityType: string; props: Record<string, unknown> }> => new Map(Object.entries(record));

beforeEach(() => {
  execMock.mockReset();
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
  test("queries az resource show with rg + name + type and flattens properties.* onto the top level", async () => {
    let receivedCmd = "";
    execMock.mockImplementation((cmd: string) => {
      receivedCmd = cmd;
      return ok({
        id: "/subscriptions/sub/resourceGroups/prod-rg/providers/Microsoft.Storage/storageAccounts/mydata",
        name: "mydata",
        type: "Microsoft.Storage/storageAccounts",
        location: "eastus",
        tags: { env: "prod" },
        etag: "\"abc\"",
        systemData: { createdBy: "someone@example.com" },
        properties: { provisioningState: "Succeeded", minimumTlsVersion: "TLS1_2", allowBlobPublicAccess: false },
      });
    });

    const result = normalizeDeepObservation(
      await observeResourcesDeepAzure({
        environment: "prod-rg",
        entityNames: ["dataAccount"],
        entities: entities({ dataAccount: { entityType: "Microsoft.Storage/storageAccounts", props: { name: "mydata" } } }),
      }),
    );

    expect(receivedCmd).toContain("az resource show");
    expect(receivedCmd).toContain("--resource-group prod-rg");
    expect(receivedCmd).toContain("--name mydata");
    expect(receivedCmd).toContain("--resource-type Microsoft.Storage/storageAccounts");

    // id/type/etag/systemData/provisioningState never reach the tree at all —
    // no declared tree yet, so this is what a one-sided read looks like.
    expect(result.resources.dataAccount).toEqual({
      type: "Microsoft.Storage/storageAccounts",
      physicalId: "/subscriptions/sub/resourceGroups/prod-rg/providers/Microsoft.Storage/storageAccounts/mydata",
      properties: { name: "mydata", location: "eastus", tags: { env: "prod" }, minimumTlsVersion: "TLS1_2", allowBlobPublicAccess: false },
    });
  });

  test("a resource not found leaves the entity out — a confirmed absence", async () => {
    execMock.mockImplementation(() => fail("ResourceNotFound: ..."));
    const result = normalizeDeepObservation(
      await observeResourcesDeepAzure({
        environment: "prod-rg",
        entityNames: ["missing"],
        entities: entities({ missing: { entityType: "Microsoft.Storage/storageAccounts", props: { name: "missing" } } }),
      }),
    );
    expect(result).toEqual({ resources: {}, unobserved: {} });
  });

  test("an expired az login is a hole, not an absence", async () => {
    execMock.mockImplementation(() => fail("Please run 'az login' to setup account."));
    const result = normalizeDeepObservation(
      await observeResourcesDeepAzure({
        environment: "prod-rg",
        entityNames: ["acct"],
        entities: entities({ acct: { entityType: "Microsoft.Storage/storageAccounts", props: { name: "acct" } } }),
      }),
    );
    expect(result.resources).toEqual({});
    expect(result.unobserved.acct.reason).toBe("no-credentials");
  });

  test("a nested ARM type is unsupported-kind, never absent — az resource show is never called", async () => {
    const result = normalizeDeepObservation(
      await observeResourcesDeepAzure({
        environment: "prod-rg",
        entityNames: ["nested"],
        entities: entities({ nested: { entityType: "Microsoft.Storage/storageAccounts/blobServices", props: { name: "default" } } }),
      }),
    );
    expect(result.resources).toEqual({});
    expect(result.unobserved.nested.reason).toBe("unsupported-kind");
    expect(execMock).not.toHaveBeenCalled();
  });

  test("a non-ARM entity type is unsupported-kind — no ARM type to query", async () => {
    const result = normalizeDeepObservation(
      await observeResourcesDeepAzure({
        environment: "prod-rg",
        entityNames: ["x"],
        entities: entities({ x: { entityType: "AWS::S3::Bucket", props: { name: "x" } } }),
      }),
    );
    expect(result.unobserved.x.reason).toBe("unsupported-kind");
    expect(execMock).not.toHaveBeenCalled();
  });

  test("an entity with no name is a hole — nothing was queried", async () => {
    const result = normalizeDeepObservation(
      await observeResourcesDeepAzure({
        environment: "prod-rg",
        entityNames: ["broken"],
        entities: entities({ broken: { entityType: "Microsoft.Storage/storageAccounts", props: {} } }),
      }),
    );
    expect(result.unobserved.broken.reason).toBe("read-failed");
    expect(execMock).not.toHaveBeenCalled();
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
    execMock.mockImplementation((cmd: string) => {
      if (cmd.includes("--name mydata")) {
        return ok({
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
        });
      }
      if (cmd.includes("--name core-vnet")) {
        return ok({
          id: "/subscriptions/sub/resourceGroups/prod/providers/Microsoft.Network/virtualNetworks/core-vnet",
          name: "core-vnet",
          location: "eastus",
          properties: {
            provisioningState: "Succeeded",
            resourceGuid: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
            // NOISE: same two prefixes, different order.
            addressSpace: { addressPrefixes: ["10.1.0.0/16", "10.0.0.0/16"] },
          },
        });
      }
      if (cmd.includes("--name secure-acct")) {
        return fail("Please run 'az login' to setup account.");
      }
      return fail("unexpected call");
    });
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
        detail: "az resource show does not accept a nested ARM type; chant never queried this resource",
      },
      { name: "secureAcct", type: "Microsoft.Storage/storageAccounts", reason: "no-credentials", detail: "Please run 'az login' to setup account." },
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
    execMock.mockImplementation(() => fail("Unable to locate credentials"));
    const result = await deepDiffForLexicon(azurePlugin, { environment: "prod", buildOutput: "", entities: declared });
    expect(result.drifted).toEqual([]);
    // blobServices is still unsupported-kind — az resource show is never even
    // called for it, so a broken CLI doesn't change its verdict.
    expect(result.unobserved.map((u) => u.name).sort()).toEqual(["blobServices", "dataAccount", "secureAcct", "vnet"]);
    expect(result.unobserved.find((u) => u.name === "blobServices")?.reason).toBe("unsupported-kind");
    expect(
      result.unobserved.filter((u) => u.name !== "blobServices").every((u) => u.reason === "read-failed"),
    ).toBe(true);
  });
});
