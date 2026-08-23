import { describe, test, expect } from "vitest";
import { writeFileSync, unlinkSync } from "node:fs";
import { describeApplyConformance } from "@intentius/chant-test-utils";
import {
  evalArmString,
  evalArm,
  armResourceUrl,
  armResourceBody,
  armDependencies,
  orderArmResources,
  azApply,
  azDelete,
  pruneArmOrphans,
  toApplyResult,
  deleteArmResource,
  listGroupResources,
  chantOwnershipTags,
  isChantOwned,
  type ArmEvalCtx,
  type ArmResource,
  type AzHttp,
  providerApiVersion,
} from "./az-apply";
import { lookupApiVersion } from "../../serializer";

const noHttp: AzHttp = async () => ({ status: 200, text: "{}" });

function ctx(over: Partial<ArmEvalCtx> = {}): ArmEvalCtx {
  return {
    subscriptionId: "sub-1",
    resourceGroup: "chant-rg",
    location: "eastus",
    deployed: new Map(),
    http: noHttp,
    base: "http://x",
    ...over,
  };
}

describe("evalArmString — static functions (#707)", () => {
  test("resourceGroup / subscription / concat / uniqueString", async () => {
    expect(await evalArmString("[resourceGroup().location]", ctx())).toBe("eastus");
    expect(await evalArmString("[resourceGroup().id]", ctx())).toBe("/subscriptions/sub-1/resourceGroups/chant-rg");
    expect(await evalArmString("[subscription().subscriptionId]", ctx())).toBe("sub-1");
    const v = await evalArmString("[concat('store', uniqueString(resourceGroup().id))]", ctx());
    expect(String(v)).toHaveLength("store".length + 13);
  });

  test("resourceId('type','name') → the resource-id path", async () => {
    expect(await evalArmString("[resourceId('Microsoft.Web/serverfarms', 'plan1')]", ctx())).toBe(
      "/subscriptions/sub-1/resourceGroups/chant-rg/providers/Microsoft.Web/serverfarms/plan1",
    );
  });

  test("non-expression + [[ escape passthrough", async () => {
    expect(await evalArmString("plain", ctx())).toBe("plain");
    expect(await evalArmString("[[literal]", ctx())).toBe("[literal]");
  });
});

describe("evalArmString — reference() (#707)", () => {
  test("reference('name') → the applied resource's properties, with .prop access", async () => {
    const deployed = new Map<string, unknown>([
      ["mystore", { properties: { primaryEndpoints: { blob: "http://mystore.blob/" } } }],
    ]);
    expect(await evalArmString("[reference('mystore').primaryEndpoints.blob]", ctx({ deployed }))).toBe(
      "http://mystore.blob/",
    );
  });
});

describe("evalArmString — listKeys() (#707)", () => {
  test("listKeys(resourceId(...), v).keys[0].value → POSTs the key action and indexes", async () => {
    const calls: string[] = [];
    const http: AzHttp = async (method, url) => {
      calls.push(`${method} ${url}`);
      return { status: 200, text: JSON.stringify({ keys: [{ value: "SECRET-KEY" }, { value: "k2" }] }) };
    };
    const expr = "[concat('AccountKey=', listKeys(resourceId('Microsoft.Storage/storageAccounts', 'st'), '2023-01-01').keys[0].value)]";
    expect(await evalArmString(expr, ctx({ http }))).toBe("AccountKey=SECRET-KEY");
    expect(calls[0]).toBe("POST http://x/subscriptions/sub-1/resourceGroups/chant-rg/providers/Microsoft.Storage/storageAccounts/st/listKeys?api-version=2023-01-01");
  });
});

describe("evalArm recursion (#707)", () => {
  test("recurses objects/arrays, resolving async expressions", async () => {
    expect(await evalArm({ a: "[resourceGroup().location]", b: ["[subscription().subscriptionId]", 1] }, ctx())).toEqual({
      a: "eastus",
      b: ["sub-1", 1],
    });
  });
});

describe("dependency ordering (#707)", () => {
  const plan: ArmResource = { type: "Microsoft.Web/serverfarms", apiVersion: "2023-01-01", name: "plan1" };
  const store: ArmResource = { type: "Microsoft.Storage/storageAccounts", apiVersion: "2023-01-01", name: "st1" };
  const site: ArmResource = {
    type: "Microsoft.Web/sites",
    apiVersion: "2023-01-01",
    name: "site1",
    properties: {
      serverFarmId: "[resourceId('Microsoft.Web/serverfarms', 'plan1')]",
      conn: "[listKeys(resourceId('Microsoft.Storage/storageAccounts', 'st1'), '2023-01-01')]",
    },
  };

  test("armDependencies finds referenced resource names in the template", () => {
    expect(armDependencies(site, new Set(["plan1", "st1", "site1"])).sort()).toEqual(["plan1", "st1"]);
    expect(armDependencies(plan, new Set(["plan1", "st1", "site1"]))).toEqual([]);
  });

  test("orderArmResources applies dependencies before the referrer", () => {
    const ordered = orderArmResources([site, plan, store]).map((r) => r.name);
    expect(ordered.indexOf("plan1")).toBeLessThan(ordered.indexOf("site1"));
    expect(ordered.indexOf("st1")).toBeLessThan(ordered.indexOf("site1"));
  });

  test("throws on a cycle", () => {
    const a: ArmResource = { type: "T", apiVersion: "v", name: "a", properties: { r: "[resourceId('T', 'b')]" } };
    const b: ArmResource = { type: "T", apiVersion: "v", name: "b", properties: { r: "[resourceId('T', 'a')]" } };
    expect(() => orderArmResources([a, b])).toThrow(/reference cycle/);
  });
});

const STORAGE: ArmResource = {
  type: "Microsoft.Storage/storageAccounts",
  apiVersion: "2025-06-01",
  name: "chantstore1",
  location: "[resourceGroup().location]",
  sku: { name: "Standard_LRS" },
  kind: "StorageV2",
  properties: { minimumTlsVersion: "TLS1_2" },
  tags: { "managed-by": "chant" },
};

describe("armResourceUrl / armResourceBody (#707)", () => {
  test("URL is the resource-id PUT path", async () => {
    expect(await armResourceUrl(STORAGE, ctx())).toBe(
      "http://x/subscriptions/sub-1/resourceGroups/chant-rg/providers/Microsoft.Storage/storageAccounts/chantstore1?api-version=2025-06-01",
    );
  });

  test("body evaluates location, keeps sku/kind/tags/properties", async () => {
    expect(await armResourceBody(STORAGE, ctx())).toEqual({
      location: "eastus",
      sku: { name: "Standard_LRS" },
      kind: "StorageV2",
      properties: { minimumTlsVersion: "TLS1_2" },
      tags: { "managed-by": "chant" },
    });
  });
});

describe("azApply flow (#707)", () => {
  test("ensures the resource group, applies in dependency order, captures state", async () => {
    const calls: Array<{ method: string; url: string }> = [];
    const http: AzHttp = async (method, url) => {
      calls.push({ method, url });
      return { status: 200, text: "{}" };
    };
    const fs = await import("node:fs");
    const tmp = `/tmp/chant-arm-${process.pid}.json`;
    const site: ArmResource = {
      type: "Microsoft.Web/sites",
      apiVersion: "2023-01-01",
      name: "site1",
      properties: { serverFarmId: "[resourceId('Microsoft.Web/serverfarms', 'plan1')]" },
    };
    const plan: ArmResource = { type: "Microsoft.Web/serverfarms", apiVersion: "2023-01-01", name: "plan1" };
    fs.writeFileSync(tmp, JSON.stringify({ resources: [site, plan] })); // listed out of order
    const res = await azApply({ templatePath: tmp, resourceGroup: "chant-rg", location: "eastus", endpoint: "http://x", subscriptionId: "sub-1" }, undefined, http);
    fs.unlinkSync(tmp);
    // plan (dependency) applied before site (referrer), despite manifest order.
    expect(res.applied.map((a) => a.name)).toEqual(["plan1", "site1"]);
    const puts = calls.filter((c) => c.method === "PUT" && c.url.includes("/providers/"));
    expect(puts[0].url).toContain("/serverfarms/plan1");
    expect(puts[1].url).toContain("/sites/site1");
  });

  test("surfaces a resource apply failure", async () => {
    const fs = await import("node:fs");
    const tmp = `/tmp/chant-arm-fail-${process.pid}.json`;
    fs.writeFileSync(tmp, JSON.stringify({ resources: [STORAGE] }));
    const http: AzHttp = async (_method, url) =>
      url.includes("/providers/") ? { status: 400, text: "denied" } : { status: 200, text: "" };
    await expect(
      azApply({ templatePath: tmp, resourceGroup: "rg", endpoint: "http://x" }, undefined, http),
    ).rejects.toThrow(/Microsoft.Storage\/storageAccounts chantstore1 apply failed \(400\)/);
    fs.unlinkSync(tmp);
  });

  test("stamps chant ownership on the PUT body", async () => {
    const fs = await import("node:fs");
    const tmp = `/tmp/chant-arm-own-${process.pid}.json`;
    fs.writeFileSync(tmp, JSON.stringify({ resources: [{ type: "T", apiVersion: "v", name: "r1" }] }));
    let putBody: Record<string, unknown> | undefined;
    const http: AzHttp = async (method, url, body) => {
      if (method === "PUT" && url.includes("/providers/")) putBody = body as Record<string, unknown>;
      return { status: 200, text: "{}" };
    };
    await azApply({ templatePath: tmp, resourceGroup: "rg", endpoint: "http://x" }, undefined, http);
    fs.unlinkSync(tmp);
    expect((putBody?.tags as Record<string, string>)["managed-by"]).toBe("chant");
  });
});

describe("ownership helpers (#azure-prune)", () => {
  // #1446: the applier used a bare `managed-by` while the lexicon's declared
  // channel (AZURE_TAG_OWNERSHIP_KEYS, what the serializer stamps and
  // live-export filters on) is `chant-managed-by`. Both are ordinary ARM tag
  // keys on the same surface, so nothing forced the difference — and it meant a
  // resource carrying only the serializer's marker read as foreign here.
  test("stamps the lexicon's declared channel, plus the legacy key", () => {
    expect(chantOwnershipTags()).toEqual({
      "chant-managed-by": "chant",
      "managed-by": "chant",
    });
  });

  test("recognises the declared channel — the marker the serializer stamps", () => {
    expect(isChantOwned({ "chant-managed-by": "chant" })).toBe(true);
  });

  test("still recognises the legacy key, so nothing already deployed is orphaned", () => {
    expect(isChantOwned({ "managed-by": "chant" })).toBe(true);
  });

  test("a foreign or unmarked resource is still foreign", () => {
    expect(isChantOwned({ "managed-by": "someone-else" })).toBe(false);
    expect(isChantOwned({ "chant-managed-by": "terraform" })).toBe(false);
    expect(isChantOwned({})).toBe(false);
    expect(isChantOwned(undefined)).toBe(false);
  });
});

describe("deleteArmResource (#azure-prune)", () => {
  test("DELETEs the resource-id path; 404 is not-deleted", async () => {
    const calls: string[] = [];
    const http: AzHttp = async (method, url) => {
      calls.push(`${method} ${url}`);
      return { status: 200, text: "" };
    };
    const res = await deleteArmResource("Microsoft.Storage/storageAccounts", "st1", "2023-01-01", ctx(), http);
    expect(res).toEqual({ type: "Microsoft.Storage/storageAccounts", name: "st1", deleted: true });
    expect(calls[0]).toBe(
      "DELETE http://x/subscriptions/sub-1/resourceGroups/chant-rg/providers/Microsoft.Storage/storageAccounts/st1?api-version=2023-01-01",
    );
    const gone = await deleteArmResource("T", "x", "v", ctx(), async () => ({ status: 404, text: "" }));
    expect(gone.deleted).toBe(false);
  });

  test("throws on a non-404 error", async () => {
    await expect(
      deleteArmResource("T", "x", "v", ctx(), async () => ({ status: 403, text: "no" })),
    ).rejects.toThrow(/T x delete failed \(403\)/);
  });
});

describe("listGroupResources (#azure-prune)", () => {
  test("returns the value[] items, filtering malformed entries", async () => {
    const http: AzHttp = async () => ({
      status: 200,
      text: JSON.stringify({ value: [{ id: "/a", name: "a", type: "T", tags: { "managed-by": "chant" } }, { id: "/bad" }] }),
    });
    const items = await listGroupResources(ctx(), http);
    expect(items.map((i) => i.name)).toEqual(["a"]);
  });

  test("returns [] on an error status", async () => {
    expect(await listGroupResources(ctx(), async () => ({ status: 500, text: "" }))).toEqual([]);
  });
});

describe("pruneArmOrphans (#azure-prune)", () => {
  const desired: ArmResource[] = [{ type: "Microsoft.Storage/storageAccounts", apiVersion: "2023-01-01", name: "keep1" }];

  test("deletes only chant-owned, templated-type resources not in the template", async () => {
    const live = {
      value: [
        { id: "/1", name: "keep1", type: "Microsoft.Storage/storageAccounts", tags: { "managed-by": "chant" } }, // in template → keep
        { id: "/2", name: "orphan1", type: "Microsoft.Storage/storageAccounts", tags: { "managed-by": "chant" } }, // owned, not in template → prune
        { id: "/3", name: "foreign", type: "Microsoft.Storage/storageAccounts", tags: {} }, // not owned → skip
        { id: "/4", name: "othertype", type: "Microsoft.Web/sites", tags: { "managed-by": "chant" } }, // type not templated → registry apiVersion
      ],
    };
    const deletes: string[] = [];
    const http: AzHttp = async (method, url) => {
      if (method === "DELETE") deletes.push(url);
      return { status: 200, text: method === "GET" ? JSON.stringify(live) : "" };
    };
    const { pruned, notPrunable } = await pruneArmOrphans(desired, ctx(), http);
    expect(pruned).toEqual([
      { type: "Microsoft.Storage/storageAccounts", name: "orphan1", deleted: true },
      { type: "Microsoft.Web/sites", name: "othertype", deleted: true },
    ]);
    expect(deletes).toHaveLength(2);
    expect(deletes[0]).toContain("/storageAccounts/orphan1?api-version=2023-01-01"); // apiVersion from the template
    // #1472: "othertype" is chant-owned and undeclared, and its TYPE is absent
    // from the template — the apiVersion comes from the lexicon registry instead.
    expect(deletes[1]).toContain(`/sites/othertype?api-version=${lookupApiVersion("Microsoft.Web/sites")}`);
    expect(notPrunable).toEqual([]);
  });

  // #1448 routes ApplyOp's `arm` target here, so this is now the delete scope for
  // `delete: "owned-only"` — not `az deployment --mode Complete`, whose scope was
  // the whole resource group. Asserted on the transport: an untagged resource
  // must receive no DELETE at all, not merely be absent from the return value.
  test("issues no delete against an untagged resource, even when it is an orphan", async () => {
    const live = {
      value: [
        { id: "/1", name: "orphan-foreign", type: "Microsoft.Storage/storageAccounts", tags: { "managed-by": "terraform" } },
        { id: "/2", name: "orphan-untagged", type: "Microsoft.Storage/storageAccounts" },
      ],
    };
    const deletes: string[] = [];
    const http: AzHttp = async (method, url) => {
      if (method === "DELETE") deletes.push(url);
      return { status: 200, text: method === "GET" ? JSON.stringify(live) : "" };
    };
    const { pruned, notPrunable } = await pruneArmOrphans(desired, ctx(), http);
    expect(deletes).toEqual([]);
    expect(pruned).toEqual([]);
    // Foreign resources are not chant's orphans, so they are not reported as
    // ones chant failed to prune either — ownership is checked first.
    expect(notPrunable).toEqual([]);
  });

  // The caveat that was a comment on OWNERSHIP_TAG_KEY: floci-az drops resource
  // tags, so nothing reads back as chant-owned there. Pinned as behaviour because
  // the failure direction matters — it fails CLOSED (prunes nothing) rather than
  // open, so the emulator under-deletes instead of deleting a stranger's
  // resource. It also means an owned-only prune cannot be verified on floci-az;
  // that verification needs real Azure.
  test("prunes nothing when the transport drops tags, as floci-az does", async () => {
    const live = {
      value: [{ id: "/1", name: "orphan1", type: "Microsoft.Storage/storageAccounts" }], // tags dropped
    };
    const deletes: string[] = [];
    const http: AzHttp = async (method, url) => {
      if (method === "DELETE") deletes.push(url);
      return { status: 200, text: method === "GET" ? JSON.stringify(live) : "" };
    };
    expect(await pruneArmOrphans(desired, ctx(), http)).toEqual({ pruned: [], notPrunable: [] });
    expect(deletes).toEqual([]);
  });
});

describe("azApply prune flag (#azure-prune)", () => {
  test("prunes owned orphans of a templated type after applying", async () => {
    const fs = await import("node:fs");
    const tmp = `/tmp/chant-arm-prune-${process.pid}.json`;
    fs.writeFileSync(tmp, JSON.stringify({ resources: [{ type: "T", apiVersion: "v", name: "keep1" }] }));
    const live = { value: [{ id: "/o", name: "orphan1", type: "T", tags: { "managed-by": "chant" } }] };
    const deletes: string[] = [];
    const http: AzHttp = async (method, url) => {
      if (method === "DELETE") deletes.push(url);
      return { status: 200, text: method === "GET" ? JSON.stringify(live) : "{}" };
    };
    const res = await azApply({ templatePath: tmp, resourceGroup: "rg", endpoint: "http://x", prune: true }, undefined, http);
    fs.unlinkSync(tmp);
    expect(res.applied.map((a) => a.name)).toEqual(["keep1"]);
    expect(res.pruned).toEqual([{ type: "T", name: "orphan1", deleted: true }]);
    expect(deletes[0]).toContain("/providers/T/orphan1");
  });

  test("no prune when the flag is off", async () => {
    const fs = await import("node:fs");
    const tmp = `/tmp/chant-arm-noprune-${process.pid}.json`;
    fs.writeFileSync(tmp, JSON.stringify({ resources: [{ type: "T", apiVersion: "v", name: "keep1" }] }));
    let listed = false;
    const http: AzHttp = async (method, url) => {
      if (method === "GET" && url.includes("/resources?")) listed = true;
      return { status: 200, text: "{}" };
    };
    const res = await azApply({ templatePath: tmp, resourceGroup: "rg", endpoint: "http://x" }, undefined, http);
    fs.unlinkSync(tmp);
    expect(res.pruned).toEqual([]);
    expect(listed).toBe(false);
  });
});

describe("azDelete (#azure-prune)", () => {
  test("deletes declared resources in reverse dependency order", async () => {
    const fs = await import("node:fs");
    const tmp = `/tmp/chant-arm-del-${process.pid}.json`;
    const site: ArmResource = {
      type: "Microsoft.Web/sites",
      apiVersion: "2023-01-01",
      name: "site1",
      properties: { serverFarmId: "[resourceId('Microsoft.Web/serverfarms', 'plan1')]" },
    };
    const plan: ArmResource = { type: "Microsoft.Web/serverfarms", apiVersion: "2023-01-01", name: "plan1" };
    fs.writeFileSync(tmp, JSON.stringify({ resources: [plan, site] }));
    const deletes: string[] = [];
    const http: AzHttp = async (method, url) => {
      if (method === "DELETE") deletes.push(url);
      return { status: 200, text: "" };
    };
    const res = await azDelete({ templatePath: tmp, resourceGroup: "chant-rg", endpoint: "http://x" }, undefined, http);
    fs.unlinkSync(tmp);
    // referrer (site) deleted before the resource it references (plan).
    expect(res.deleted.map((d) => d.name)).toEqual(["site1", "plan1"]);
    expect(deletes[0]).toContain("/sites/site1");
    expect(deletes[1]).toContain("/serverfarms/plan1");
  });
});

/**
 * #1457 — the permanent-orphan case, stated as its own scenario rather than a
 * clause in another test.
 *
 * Prune the LAST resource of a type and the template stops mentioning that type
 * at all. `byType` then has no entry, and the `!entry` guard skipped the live
 * resource before ownership was ever checked. It is owned, undeclared, and was
 * unreachable by prune forever. Prune one of SEVERAL and it works, which is why
 * this survived testing.
 */
describe("pruneArmOrphans: a type that left the template (#1457, #1472)", () => {
  const ctx = (): ArmEvalCtx => ({
    subscriptionId: "sub",
    resourceGroup: "rg",
    location: "eastus",
    deployed: new Map(),
    http: async () => ({ status: 200, text: "" }),
    base: "http://x",
  });

  // Only the resource-group listing answers; the provider-metadata endpoint
  // 404s, the way floci-az does.
  const liveHttp = (value: unknown[], deletes: string[], providers: string[] = []): AzHttp =>
    async (method, url) => {
      if (method === "DELETE") deletes.push(url);
      if (method === "GET" && url.includes("/resources?")) return { status: 200, text: JSON.stringify({ value }) };
      if (method === "GET" && url.includes("/providers/")) {
        providers.push(url);
        return { status: 404, text: "" };
      }
      return { status: 200, text: "" };
    };

  test("an owned orphan whose type is gone is deleted with the registry apiVersion", async () => {
    // The template now declares a DIFFERENT type entirely — the storage account
    // was the last of its kind and has been removed from source. #1457 only
    // reported this; the registry the serializer pins from now supplies the
    // apiVersion, so the orphan is actually deleted.
    const desired: ArmResource[] = [
      { type: "Microsoft.Web/sites", apiVersion: "2022-03-01", name: "site" },
    ];
    const deletes: string[] = [];
    const providers: string[] = [];
    const http = liveHttp(
      [{ id: "/1", name: "leftover", type: "Microsoft.Storage/storageAccounts", tags: { "managed-by": "chant" } }],
      deletes,
      providers,
    );
    const { pruned, notPrunable } = await pruneArmOrphans(desired, ctx(), http);
    expect(pruned).toEqual([{ type: "Microsoft.Storage/storageAccounts", name: "leftover", deleted: true }]);
    expect(notPrunable).toEqual([]);
    const registryVersion = lookupApiVersion("Microsoft.Storage/storageAccounts");
    expect(registryVersion).toBeDefined();
    expect(deletes).toEqual([
      `http://x/subscriptions/sub/resourceGroups/rg/providers/Microsoft.Storage/storageAccounts/leftover?api-version=${registryVersion}`,
    ]);
    // The registry answered, so ARM's provider metadata was never consulted.
    expect(providers).toEqual([]);
  });

  test("the live listing's type casing need not match the registry's", async () => {
    const desired: ArmResource[] = [];
    const deletes: string[] = [];
    const http = liveHttp(
      [{ id: "/1", name: "leftover", type: "microsoft.storage/storageaccounts", tags: { "managed-by": "chant" } }],
      deletes,
    );
    const { pruned, notPrunable } = await pruneArmOrphans(desired, ctx(), http);
    expect(pruned).toEqual([{ type: "microsoft.storage/storageaccounts", name: "leftover", deleted: true }]);
    expect(notPrunable).toEqual([]);
    expect(deletes[0]).toContain(`?api-version=${lookupApiVersion("Microsoft.Storage/storageAccounts")}`);
  });

  test("a type the registry does not know falls back to ARM provider metadata, newest stable", async () => {
    const desired: ArmResource[] = [];
    const deletes: string[] = [];
    const gets: string[] = [];
    const http: AzHttp = async (method, url) => {
      if (method === "DELETE") deletes.push(url);
      if (method === "GET") gets.push(url);
      if (method === "GET" && url.includes("/resources?")) {
        return {
          status: 200,
          text: JSON.stringify({
            value: [
              { id: "/1", name: "a", type: "Microsoft.Example/widgets", tags: { "managed-by": "chant" } },
              { id: "/2", name: "b", type: "Microsoft.Example/widgets", tags: { "managed-by": "chant" } },
            ],
          }),
        };
      }
      if (method === "GET" && url.includes("/providers/Microsoft.Example?")) {
        return {
          status: 200,
          text: JSON.stringify({
            namespace: "Microsoft.Example",
            resourceTypes: [
              { resourceType: "widgets", apiVersions: ["2024-05-01-preview", "2023-09-01", "2024-01-01", "2022-01-01"] },
              { resourceType: "gadgets", apiVersions: ["2020-01-01"] },
            ],
          }),
        };
      }
      return { status: 200, text: "" };
    };
    const { pruned, notPrunable } = await pruneArmOrphans(desired, ctx(), http);
    expect(pruned).toEqual([
      { type: "Microsoft.Example/widgets", name: "a", deleted: true },
      { type: "Microsoft.Example/widgets", name: "b", deleted: true },
    ]);
    expect(notPrunable).toEqual([]);
    // Newest STABLE wins over the newer preview.
    expect(deletes).toEqual([
      "http://x/subscriptions/sub/resourceGroups/rg/providers/Microsoft.Example/widgets/a?api-version=2024-01-01",
      "http://x/subscriptions/sub/resourceGroups/rg/providers/Microsoft.Example/widgets/b?api-version=2024-01-01",
    ]);
    // One provider-metadata call per namespace per run, not per orphan.
    expect(gets.filter((u) => u.includes("/providers/Microsoft.Example?api-version=2021-04-01"))).toHaveLength(1);
    expect(gets.find((u) => u.includes("/providers/Microsoft.Example?"))).toBe(
      "http://x/subscriptions/sub/providers/Microsoft.Example?api-version=2021-04-01",
    );
  });

  test("no template, no registry entry, no provider metadata → still reported, never deleted", async () => {
    const desired: ArmResource[] = [];
    const deletes: string[] = [];
    const providers: string[] = [];
    const http = liveHttp(
      [{ id: "/1", name: "mystery", type: "Microsoft.Nowhere/things", tags: { "managed-by": "chant" } }],
      deletes,
      providers,
    );
    const { pruned, notPrunable } = await pruneArmOrphans(desired, ctx(), http);
    expect(pruned).toEqual([]);
    expect(notPrunable).toEqual([{ type: "Microsoft.Nowhere/things", name: "mystery", reason: "no-api-version" }]);
    expect(deletes).toEqual([]);
    // All three sources were tried; the last one is the provider endpoint.
    expect(providers).toEqual(["http://x/subscriptions/sub/providers/Microsoft.Nowhere?api-version=2021-04-01"]);
  });

  test("providerApiVersion: preview-only types, missing types, and failed calls", async () => {
    const cache = new Map<string, Map<string, string>>();
    let calls = 0;
    const http: AzHttp = async () => {
      calls++;
      return {
        status: 200,
        text: JSON.stringify({
          resourceTypes: [{ resourceType: "previewOnly", apiVersions: ["2023-01-01-preview", "2024-01-01-preview"] }],
        }),
      };
    };
    expect(await providerApiVersion("Microsoft.P/previewOnly", ctx(), http, undefined, cache)).toBe("2024-01-01-preview");
    expect(await providerApiVersion("Microsoft.P/absent", ctx(), http, undefined, cache)).toBeUndefined();
    expect(calls).toBe(1);
    expect(await providerApiVersion("notatype", ctx(), http)).toBeUndefined();
    const failing: AzHttp = async () => { throw new Error("network"); };
    expect(await providerApiVersion("Microsoft.P/previewOnly", ctx(), failing)).toBeUndefined();
  });

  test("azApply end to end: declare one storage account, apply, remove it, prune → deleted", async () => {
    // The Floci-az style fake: PUT records the resource (with the ownership tag
    // chant stamps), the group listing echoes what was recorded, DELETE removes
    // it. The provider-metadata endpoint is absent, as on floci-az.
    const store = new Map<string, { id: string; name: string; type: string; tags?: Record<string, string> }>();
    const deletes: string[] = [];
    const http: AzHttp = async (method, url, body) => {
      const m = url.match(/\/providers\/([^/]+\/[^/]+)\/([^/?]+)\?api-version=([^&]+)$/);
      if (method === "PUT" && m) {
        const tags = (body as { tags?: Record<string, string> }).tags;
        store.set(`${m[1]}/${m[2]}`, { id: `/${m[2]}`, name: m[2], type: m[1], tags });
        return { status: 200, text: JSON.stringify({ properties: {} }) };
      }
      if (method === "DELETE" && m) {
        deletes.push(url);
        const had = store.delete(`${m[1]}/${m[2]}`);
        return { status: had ? 200 : 404, text: "" };
      }
      if (method === "GET" && url.includes("/resources?")) {
        return { status: 200, text: JSON.stringify({ value: [...store.values()] }) };
      }
      return { status: 404, text: "" };
    };
    const path = `/tmp/chant-1472-az-${process.pid}.json`;
    const account = { type: "Microsoft.Storage/storageAccounts", apiVersion: "2023-01-01", name: "lastone" };
    try {
      writeFileSync(path, JSON.stringify({ resources: [account] }));
      const first = await azApply({ templatePath: path, resourceGroup: "rg", endpoint: "http://x", prune: true }, undefined, http);
      expect(first.applied).toEqual([{ type: account.type, name: "lastone" }]);
      expect(store.size).toBe(1);

      // Remove the only storage account from source: the template now declares
      // no resource of that type at all.
      writeFileSync(path, JSON.stringify({ resources: [] }));
      const second = await azApply({ templatePath: path, resourceGroup: "rg", endpoint: "http://x", prune: true }, undefined, http);
      expect(second.applied).toEqual([]);
      expect(second.pruned).toEqual([{ type: account.type, name: "lastone", deleted: true }]);
      expect(second.notPrunable).toEqual([]);
      expect(store.size).toBe(0);
      expect(deletes).toEqual([
        `http://x/subscriptions/${"00000000-0000-0000-0000-000000000001"}/resourceGroups/rg/providers/Microsoft.Storage/storageAccounts/lastone?api-version=${lookupApiVersion(account.type)}`,
      ]);
      // Core's envelope agrees: nothing left over that could not be attempted.
      expect(toApplyResult(second).notAttempted ?? []).toEqual([]);
    } finally {
      unlinkSync(path);
    }
  });

  test("pruning one of several of a type still works — the case that hid this", async () => {
    const desired: ArmResource[] = [
      { type: "Microsoft.Storage/storageAccounts", apiVersion: "2023-01-01", name: "keep" },
    ];
    const deletes: string[] = [];
    const http = liveHttp(
      [
        { id: "/1", name: "keep", type: "Microsoft.Storage/storageAccounts", tags: { "managed-by": "chant" } },
        { id: "/2", name: "gone", type: "Microsoft.Storage/storageAccounts", tags: { "managed-by": "chant" } },
      ],
      deletes,
    );
    const { pruned, notPrunable } = await pruneArmOrphans(desired, ctx(), http);
    expect(pruned).toEqual([{ type: "Microsoft.Storage/storageAccounts", name: "gone", deleted: true }]);
    expect(notPrunable).toEqual([]);
    expect(deletes).toHaveLength(1);
  });

  test("a foreign resource of a departed type is not reported as chant's problem", async () => {
    const desired: ArmResource[] = [
      { type: "Microsoft.Web/sites", apiVersion: "2022-03-01", name: "site" },
    ];
    const deletes: string[] = [];
    const http = liveHttp(
      [{ id: "/1", name: "theirs", type: "Microsoft.Storage/storageAccounts", tags: { "managed-by": "terraform" } }],
      deletes,
    );
    const { pruned, notPrunable } = await pruneArmOrphans(desired, ctx(), http);
    expect(pruned).toEqual([]);
    expect(notPrunable).toEqual([]);
    expect(deletes).toEqual([]);
  });
});

/**
 * The shared apply-contract suite (#1446), run against azure's own mocked
 * transport. Assertion 4 — the owned-only prune, asserted on the transport — is
 * the one that matters most here: it is what #1448 violated, and what the
 * two-key split found in #1446 made unreliable even after #1448.
 */
describeApplyConformance({
  lexicon: "azure",
  scenarios: [
    {
      name: "a template of two resources",
      plan: [
        { kind: "Microsoft.Storage/storageAccounts", name: "one" },
        { kind: "Microsoft.Storage/storageAccounts", name: "two" },
      ],
      run: async () => {
        const path = `/tmp/chant-1446-az-${process.pid}.json`;
        writeFileSync(
          path,
          JSON.stringify({
            resources: [
              { type: "Microsoft.Storage/storageAccounts", apiVersion: "2023-01-01", name: "one" },
              { type: "Microsoft.Storage/storageAccounts", apiVersion: "2023-01-01", name: "two" },
            ],
          }),
        );
        try {
          const http: AzHttp = async () => ({ status: 200, text: "{}" });
          return toApplyResult(
            await azApply({ templatePath: path, resourceGroup: "rg", endpoint: "http://x" }, undefined, http),
          );
        } finally {
          unlinkSync(path);
        }
      },
      expectApplied: [
        "Microsoft.Storage/storageAccounts/one",
        "Microsoft.Storage/storageAccounts/two",
      ],
    },
  ],
  pruneScenarios: [
    {
      name: "an owned orphan beside a foreign resource in the same group",
      ownedOrphan: "orphan",
      foreign: "foreign",
      run: async () => {
        const deletes: string[] = [];
        const live = {
          value: [
            { id: "/1", name: "keep", type: "Microsoft.Storage/storageAccounts", tags: { "chant-managed-by": "chant" } },
            { id: "/2", name: "orphan", type: "Microsoft.Storage/storageAccounts", tags: { "chant-managed-by": "chant" } },
            { id: "/3", name: "foreign", type: "Microsoft.Storage/storageAccounts", tags: { "managed-by": "terraform" } },
          ],
        };
        const path = `/tmp/chant-1446-az-prune-${process.pid}.json`;
        writeFileSync(
          path,
          JSON.stringify({
            resources: [{ type: "Microsoft.Storage/storageAccounts", apiVersion: "2023-01-01", name: "keep" }],
          }),
        );
        try {
          const http: AzHttp = async (method, url) => {
            if (method === "DELETE") deletes.push(url);
            return {
              status: 200,
              text: method === "GET" && url.includes("/resources?") ? JSON.stringify(live) : "{}",
            };
          };
          const result = toApplyResult(
            await azApply(
              { templatePath: path, resourceGroup: "rg", endpoint: "http://x", prune: true },
              undefined,
              http,
            ),
          );
          return { result, deletes };
        } finally {
          unlinkSync(path);
        }
      },
    },
  ],
});
