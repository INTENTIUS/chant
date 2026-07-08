import { describe, test, expect } from "vitest";
import {
  evalArmString,
  evalArm,
  armResourceUrl,
  armResourceBody,
  armDependencies,
  orderArmResources,
  azApply,
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
});
