import { describe, test, expect } from "vitest";
import {
  evalArmString,
  evalArm,
  armResourceUrl,
  armResourceBody,
  azApply,
  type ArmContext,
  type ArmResource,
  type AzHttp,
} from "./az-apply";

const CTX: ArmContext = {
  subscriptionId: "sub-1",
  resourceGroup: "chant-rg",
  location: "eastus",
};

describe("evalArmString (#706)", () => {
  test("resourceGroup().location / .id", () => {
    expect(evalArmString("[resourceGroup().location]", CTX)).toBe("eastus");
    expect(evalArmString("[resourceGroup().id]", CTX)).toBe("/subscriptions/sub-1/resourceGroups/chant-rg");
  });

  test("subscription().subscriptionId", () => {
    expect(evalArmString("[subscription().subscriptionId]", CTX)).toBe("sub-1");
  });

  test("concat with a literal and a nested function", () => {
    const v = evalArmString("[concat('store', uniqueString(resourceGroup().id))]", CTX);
    expect(v.startsWith("store")).toBe(true);
    expect(v).toHaveLength("store".length + 13); // uniqueString → 13 chars
  });

  test("uniqueString is deterministic for the same inputs", () => {
    const a = evalArmString("[uniqueString(resourceGroup().id)]", CTX);
    const b = evalArmString("[uniqueString(resourceGroup().id)]", CTX);
    expect(a).toBe(b);
  });

  test("non-expression strings pass through; [[ is an escaped literal", () => {
    expect(evalArmString("plain-name", CTX)).toBe("plain-name");
    expect(evalArmString("[[literal]", CTX)).toBe("[literal]");
  });

  test("evalArm recurses into objects and arrays", () => {
    expect(evalArm({ a: "[resourceGroup().location]", b: ["[subscription().subscriptionId]", 1] }, CTX)).toEqual({
      a: "eastus",
      b: ["sub-1", 1],
    });
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

describe("armResourceUrl / armResourceBody (#706)", () => {
  test("URL is the resource-id PUT path with api-version", () => {
    expect(armResourceUrl(STORAGE, CTX, "http://x")).toBe(
      "http://x/subscriptions/sub-1/resourceGroups/chant-rg/providers/Microsoft.Storage/storageAccounts/chantstore1?api-version=2025-06-01",
    );
  });

  test("body evaluates location, keeps sku/kind/tags/properties", () => {
    expect(armResourceBody(STORAGE, CTX)).toEqual({
      location: "eastus",
      sku: { name: "Standard_LRS" },
      kind: "StorageV2",
      properties: { minimumTlsVersion: "TLS1_2" },
      tags: { "managed-by": "chant" },
    });
  });
});

describe("azApply flow (#706)", () => {
  test("ensures the resource group, then PUTs each resource", async () => {
    const calls: Array<{ method: string; url: string }> = [];
    const http: AzHttp = async (method, url) => {
      calls.push({ method, url });
      return { status: 200, text: "{}" };
    };
    // Stub the template read via a data: path — azApply reads a file, so drive it
    // through the pure pieces instead by asserting the call sequence a real run makes.
    // Here we exercise the HTTP contract with a hand-built template file.
    const fs = await import("node:fs");
    const tmp = `/tmp/chant-arm-${process.pid}.json`;
    fs.writeFileSync(tmp, JSON.stringify({ resources: [STORAGE] }));
    const res = await azApply({ templatePath: tmp, resourceGroup: "chant-rg", location: "eastus", endpoint: "http://x", subscriptionId: "sub-1" }, undefined, http);
    fs.unlinkSync(tmp);
    expect(res.applied).toEqual([{ type: "Microsoft.Storage/storageAccounts", name: "chantstore1" }]);
    expect(calls[0].method).toBe("PUT");
    expect(calls[0].url).toContain("/resourceGroups/chant-rg?api-version=");
    expect(calls[1].url).toContain("/providers/Microsoft.Storage/storageAccounts/chantstore1?api-version=2025-06-01");
  });

  test("surfaces a resource apply failure (RG ok, resource PUT fails)", async () => {
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
