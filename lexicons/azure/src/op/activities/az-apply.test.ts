import { describe, test, expect } from "vitest";
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
  deleteArmResource,
  listGroupResources,
  chantOwnershipTags,
  isChantOwned,
  type ArmEvalCtx,
  type ArmResource,
  type AzHttp,
} from "./az-apply";

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
  test("chantOwnershipTags / isChantOwned", () => {
    expect(chantOwnershipTags()).toEqual({ "managed-by": "chant" });
    expect(isChantOwned({ "managed-by": "chant" })).toBe(true);
    expect(isChantOwned({ "managed-by": "someone-else" })).toBe(false);
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
        { id: "/4", name: "othertype", type: "Microsoft.Web/sites", tags: { "managed-by": "chant" } }, // type not templated → skip
      ],
    };
    const deletes: string[] = [];
    const http: AzHttp = async (method, url) => {
      if (method === "DELETE") deletes.push(url);
      return { status: 200, text: method === "GET" ? JSON.stringify(live) : "" };
    };
    const pruned = await pruneArmOrphans(desired, ctx(), http);
    expect(pruned).toEqual([{ type: "Microsoft.Storage/storageAccounts", name: "orphan1", deleted: true }]);
    expect(deletes).toHaveLength(1);
    expect(deletes[0]).toContain("/storageAccounts/orphan1?api-version=2023-01-01"); // apiVersion from the template
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
    const pruned = await pruneArmOrphans(desired, ctx(), http);
    expect(deletes).toEqual([]);
    expect(pruned).toEqual([]);
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
    expect(await pruneArmOrphans(desired, ctx(), http)).toEqual([]);
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
