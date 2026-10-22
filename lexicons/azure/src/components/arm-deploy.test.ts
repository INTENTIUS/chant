import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isPlanMovedError, type DeployContext } from "@intentius/chant/components/capability";
import { isCapabilityPlugin } from "@intentius/chant/components/capability-plugin";
import { deployUnits } from "@intentius/chant/components/deploy-units";
import type { AzHttp } from "../op/activities/az-apply";
import { ArmDeployPlanMovedError, createArmDeployCapability, type ArmDeployInput } from "./arm-deploy";
import { azureCapabilityPlugin } from "./capability-plugin";

const ENDPOINT = "http://floci-az.test";

/**
 * An in-memory ARM resource group behind the `AzHttp` seam: PUT stores a
 * resource the way ARM answers (id, leaf name, type, provisioningState),
 * GET reads it or answers 404, the group listing lists it and DELETE removes it.
 */
function fakeArm(options: { dropTags?: boolean; fail?: (method: string, url: string) => number | undefined } = {}) {
  const store = new Map<string, Record<string, unknown>>();
  const calls: Array<{ method: string; url: string }> = [];
  const groups = new Set<string>();
  const http: AzHttp = async (method, url, body) => {
    calls.push({ method, url });
    const failed = options.fail?.(method, url);
    if (failed) return { status: failed, text: JSON.stringify({ error: { code: "AuthorizationFailed", message: "denied" } }) };
    const path = new URL(url).pathname;
    const key = path.toLowerCase();
    if (/\/resourcegroups\/[^/]+$/.test(key)) {
      if (method === "PUT") groups.add(key);
      return { status: 200, text: "{}" };
    }
    if (key.endsWith("/resources")) {
      const prefix = key.slice(0, -"/resources".length);
      if (!groups.has(prefix)) return { status: 404, text: JSON.stringify({ error: { code: "ResourceGroupNotFound" } }) };
      return { status: 200, text: JSON.stringify({ value: [...store.entries()].filter(([k]) => k.startsWith(prefix)).map(([, v]) => v) }) };
    }
    if (method === "PUT") {
      const b = body as Record<string, unknown>;
      const m = /\/providers\/([^/]+\/[^/]+)\/([^/]+)$/.exec(path)!;
      const stored = {
        id: path,
        name: m[2],
        type: m[1],
        ...b,
        ...(options.dropTags ? { tags: {} } : {}),
        properties: { ...((b.properties as Record<string, unknown>) ?? {}), provisioningState: "Succeeded" },
      };
      store.set(key, stored);
      return { status: 200, text: JSON.stringify(stored) };
    }
    if (method === "DELETE") return { status: store.delete(key) ? 200 : 404, text: "" };
    const found = store.get(key);
    return found ? { status: 200, text: JSON.stringify(found) } : { status: 404, text: JSON.stringify({ error: { code: "ResourceNotFound" } }) };
  };
  return { http, calls, store };
}

const storage = (accessTier: string) => ({
  type: "Microsoft.Storage/storageAccounts",
  apiVersion: "2023-01-01",
  name: "chantst1",
  location: "[resourceGroup().location]",
  sku: { name: "Standard_LRS" },
  kind: "StorageV2",
  properties: { accessTier },
});

const site = {
  type: "Microsoft.Web/sites",
  apiVersion: "2023-01-01",
  name: "chantsite1",
  location: "eastus",
  properties: {
    serverFarmId: "[resourceId('Microsoft.Web/serverfarms', 'plan1')]",
    storageKey: "[listKeys(resourceId('Microsoft.Storage/storageAccounts', 'chantst1'), '2023-01-01').keys[0].value]",
  },
};

describe("arm-deploy (#4273)", () => {
  test("mutates with no undo, so COMP003 needs the component to opt out of rollback", () => {
    expect(createArmDeployCapability().rollbackPolicy).toBe("needs-opt-out");
  });

  let dir: string;
  let template: string;
  const ctx: DeployContext = { env: "local", component: "app" };
  const saved = { ...process.env };
  const write = (resources: unknown[], outputs?: Record<string, unknown>): void =>
    writeFileSync(template, JSON.stringify({ resources, ...(outputs ? { outputs } : {}) }));
  const input = (over: Partial<ArmDeployInput> = {}): ArmDeployInput => ({ template, resourceGroup: "chant-rg", endpoint: ENDPOINT, ...over });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "arm-deploy-"));
    template = join(dir, "deploymentTemplate.json");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    process.env = { ...saved };
  });

  test("plans a create, applies it through azApply, then plans no change and reads the outputs", async () => {
    const arm = fakeArm();
    const cap = createArmDeployCapability({ http: arm.http });
    write([storage("Hot")], {
      tier: { type: "string", value: "[reference('chantst1').accessTier]" },
      group: { type: "string", value: "[resourceGroup().name]" },
    });

    const created = await cap.plan!(ctx, input());
    expect(created.member).toBe("chant-rg");
    expect(created.changeSet!.member).toMatchObject({ member: "chant-rg", lexicon: "azure", planner: "chant", status: "planned", holes: [] });
    const [entry] = created.changeSet!.entries;
    expect(entry).toMatchObject({ address: "Microsoft.Storage/storageAccounts/chantst1", action: "create", lexicon: "azure" });
    expect(entry.attributes).toContainEqual({ path: "accessTier", after: "Hot" });
    expect(entry.attributes).toContainEqual({ path: "location", after: "eastus" });
    // The output reading the new account is known only after apply; the static one now.
    expect(created.outputs).toEqual({ known: { group: "chant-rg" }, unknown: ["tier"] });
    // Planning made no write.
    expect(arm.calls.filter((c) => c.method !== "GET")).toEqual([]);

    const applied = await cap.run({ ...ctx, plans: { "chant-rg": created.artifact } }, input());
    expect(applied.applied).toEqual([{ type: "Microsoft.Storage/storageAccounts", name: "chantst1" }]);
    expect(applied.outputs).toEqual({ tier: "Hot", group: "chant-rg" });

    const same = await cap.plan!(ctx, input());
    expect(same.changeSet!.entries.map((e) => e.action)).toEqual(["no-op"]);
    expect(same.outputs).toEqual({ known: { tier: "Hot", group: "chant-rg" }, unknown: [] });
    await expect(cap.outputs!(ctx, input())).resolves.toEqual({ tier: "Hot", group: "chant-rg" });
  });

  test("plans an update with each changed path before and after", async () => {
    const arm = fakeArm();
    const cap = createArmDeployCapability({ http: arm.http });
    write([storage("Hot")]);
    await cap.run(ctx, input());

    write([storage("Cool")]);
    const updated = await cap.plan!(ctx, input());
    const [entry] = updated.changeSet!.entries;
    expect(entry).toMatchObject({ action: "update", disruption: "in-place" });
    expect(entry.id).toContain("/storageAccounts/chantst1");
    expect(entry.attributes).toEqual([{ path: "accessTier", before: "Hot", after: "Cool" }]);
  });

  test("refuses to apply when the template moved after the plan, and changes nothing", async () => {
    const arm = fakeArm();
    const cap = createArmDeployCapability({ http: arm.http });
    write([storage("Hot")]);
    const planned = await cap.plan!(ctx, input());
    write([storage("Cool")]);
    const run = cap.run({ ...ctx, plans: { "chant-rg": planned.artifact } }, input());
    await expect(run).rejects.toBeInstanceOf(ArmDeployPlanMovedError);
    await expect(run).rejects.toSatisfy(isPlanMovedError);
    expect(arm.calls.filter((c) => c.method === "PUT")).toEqual([]);
  });

  test("ownership tags the applier stamps are not a change, even where the emulator drops them", async () => {
    for (const dropTags of [false, true]) {
      const arm = fakeArm({ dropTags });
      const cap = createArmDeployCapability({ http: arm.http });
      write([storage("Hot")]);
      await cap.run(ctx, input());
      const again = await cap.plan!(ctx, input());
      expect(again.changeSet!.entries.map((e) => e.action)).toEqual(["no-op"]);
    }
  });

  test("a value read from runtime state is unknown, and the plan never calls listKeys", async () => {
    const arm = fakeArm();
    const cap = createArmDeployCapability({ http: arm.http });
    write([site]);
    const planned = await cap.plan!(ctx, input());
    const [entry] = planned.changeSet!.entries;
    expect(entry.attributes).toContainEqual({ path: "serverFarmId", after: "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/chant-rg/providers/Microsoft.Web/serverfarms/plan1" });
    expect(entry.attributes).toContainEqual({ path: "storageKey", unknown: true });
    expect(arm.calls.some((c) => c.url.includes("listKeys"))).toBe(false);
  });

  test("with prune, a chant-owned resource the template dropped is a delete and a foreign one is left alone", async () => {
    const arm = fakeArm();
    const cap = createArmDeployCapability({ http: arm.http });
    write([storage("Hot"), { ...storage("Hot"), name: "chantst2" }]);
    await cap.run(ctx, input());
    await arm.http("PUT", `${ENDPOINT}/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/chant-rg/providers/Microsoft.Storage/storageAccounts/foreign1?api-version=2023-01-01`, { location: "eastus" });

    write([storage("Hot")]);
    const kept = await cap.plan!(ctx, input());
    expect(kept.changeSet!.entries.map((e) => e.action)).toEqual(["no-op"]);
    const pruning = await cap.plan!(ctx, input({ prune: true }));
    expect(pruning.changeSet!.entries.map((e) => [e.name, e.action, e.disruption])).toEqual([
      ["chantst1", "no-op", undefined],
      ["chantst2", "delete", "destroy"],
    ]);
    expect(pruning.planDigest).not.toBe(kept.planDigest);

    const applied = await cap.run({ ...ctx, plans: { "chant-rg": pruning.artifact } }, input({ prune: true }));
    expect(applied.pruned).toEqual([{ type: "Microsoft.Storage/storageAccounts", name: "chantst2", deleted: true }]);
  });

  test("a resource it cannot read is a hole, and the plan hands run nothing to hold it to", async () => {
    const arm = fakeArm({ fail: (method) => (method === "GET" ? 403 : undefined) });
    const cap = createArmDeployCapability({ http: arm.http });
    write([storage("Hot")]);
    const planned = await cap.plan!(ctx, input());
    expect(planned.changeSet!.entries).toEqual([]);
    expect(planned.changeSet!.member.holes).toEqual([
      { address: "Microsoft.Storage/storageAccounts/chantst1", type: "Microsoft.Storage/storageAccounts", reason: expect.stringMatching(/^no-credentials/) },
    ]);
    expect(planned.artifact).toBeUndefined();
  });

  test("a subscription ARM does not know is a hole, not a create of every resource", async () => {
    const http: AzHttp = async () => ({ status: 404, text: JSON.stringify({ error: { code: "SubscriptionNotFound", message: "no such subscription" } }) });
    const cap = createArmDeployCapability({ http });
    write([storage("Hot")]);
    const planned = await cap.plan!(ctx, input());
    expect(planned.changeSet!.entries).toEqual([]);
    expect(planned.changeSet!.member.holes).toHaveLength(1);
    expect(planned.artifact).toBeUndefined();
  });

  test("inputs from an upstream not applied yet leave a hole and read nothing", async () => {
    const arm = fakeArm();
    const cap = createArmDeployCapability({ http: arm.http });
    write([storage("Hot")]);
    const planned = await cap.plan!({ ...ctx, unresolvedInputs: ["network"] }, input());
    expect(planned.changeSet!.member.holes).toEqual([
      { address: "chant-rg", type: "Microsoft.Resources/resourceGroups", reason: "inputs from network; re-checked on apply" },
    ]);
    expect(arm.calls).toEqual([]);
  });

  test("honours AZURE_ENDPOINT_URL and AZURE_SUBSCRIPTION_ID, and defaults the group to the component", async () => {
    process.env.AZURE_ENDPOINT_URL = "http://localhost:4577/";
    process.env.AZURE_SUBSCRIPTION_ID = "sub-test";
    const arm = fakeArm();
    const cap = createArmDeployCapability({ http: arm.http });
    write([storage("Hot")]);
    const planned = await cap.plan!(ctx, { template });
    expect(planned.member).toBe("app");
    expect(arm.calls[0].url).toBe(
      "http://localhost:4577/subscriptions/sub-test/resourceGroups/app/providers/Microsoft.Storage/storageAccounts/chantst1?api-version=2023-01-01",
    );
  });
});

describe("azureCapabilityPlugin (#4273)", () => {
  test("satisfies the CapabilityPlugin contract and registers arm-deploy with plan and outputs", () => {
    expect(isCapabilityPlugin(azureCapabilityPlugin)).toBe(true);
    const [cap] = azureCapabilityPlugin.capabilities();
    expect(cap.kind).toBe("arm-deploy");
    expect(typeof cap.plan).toBe("function");
    expect(typeof cap.outputs).toBe("function");
  });

  test("an arm-deploy step's unit is its resource group", () => {
    expect(deployUnits([{ steps: [{ kind: "arm-deploy", template: "t.json", resourceGroup: "rg1" }] }])).toEqual([{ unit: "rg1", lexicon: "azure" }]);
  });
});
