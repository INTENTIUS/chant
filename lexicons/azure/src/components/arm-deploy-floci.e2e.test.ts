/**
 * `arm-deploy`'s plan and apply against floci-az (#4273), over `fetch`. Set
 * CHANT_FLOCI_AZ_ENDPOINT to a running floci-az, for example
 * `docker run -d --name chant-floci-az-e2e -p 4577:4577 floci/floci-az:0.10.0`
 * and `CHANT_FLOCI_AZ_ENDPOINT=http://localhost:4577`. Skipped without it.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { azDelete } from "../op/activities/az-apply";
import { ArmDeployPlanMovedError, createArmDeployCapability } from "./arm-deploy";

const endpoint = process.env.CHANT_FLOCI_AZ_ENDPOINT;

describe.skipIf(!endpoint)("arm-deploy plan against floci-az (#4273)", () => {
  const resourceGroup = `chant-arm-plan-${process.pid}`;
  const ctx = { env: "local", component: resourceGroup };
  const saved = { ...process.env };
  let dir: string;
  let template: string;
  const account = (accessTier: string) => ({
    type: "Microsoft.Storage/storageAccounts",
    apiVersion: "2023-01-01",
    name: `chantplan${process.pid}`,
    location: "[resourceGroup().location]",
    sku: { name: "Standard_LRS" },
    kind: "StorageV2",
    properties: { accessTier },
  });
  const write = (accessTier: string): void =>
    writeFileSync(
      template,
      JSON.stringify({
        resources: [account(accessTier)],
        outputs: { group: { type: "string", value: "[resourceGroup().name]" } },
      }),
    );

  beforeAll(() => {
    process.env.AZURE_ENDPOINT_URL = endpoint;
    dir = mkdtempSync(join(tmpdir(), "arm-plan-floci-az-"));
    template = join(dir, "deploymentTemplate.json");
  });

  afterAll(async () => {
    try {
      await azDelete({ templatePath: template, resourceGroup, endpoint });
    } catch { /* never created */ }
    process.env = saved;
    rmSync(dir, { recursive: true, force: true });
  });

  it("plans a create, applies it, plans no change, plans an update and refuses a plan the template moved past", async () => {
    const capability = createArmDeployCapability();
    const input = { template, resourceGroup };

    write("Hot");
    const created = await capability.plan!(ctx, input);
    expect(created.changeSet!.entries.map((e) => e.action)).toEqual(["create"]);
    const first = await capability.run({ ...ctx, plans: { [resourceGroup]: created.artifact } }, input);
    expect(first.applied).toHaveLength(1);
    expect(first.outputs).toEqual({ group: resourceGroup });

    const same = await capability.plan!(ctx, input);
    expect(same.changeSet!.entries.map((e) => e.action)).toEqual(["no-op"]);

    write("Cool");
    const updated = await capability.plan!(ctx, input);
    expect(updated.changeSet!.entries.map((e) => [e.action, e.attributes])).toEqual([
      ["update", [{ path: "accessTier", before: "Hot", after: "Cool" }]],
    ]);

    // The template moves after the plan: run refuses and changes nothing.
    write("Hot");
    await expect(capability.run({ ...ctx, plans: { [resourceGroup]: updated.artifact } }, input)).rejects.toBeInstanceOf(ArmDeployPlanMovedError);
    expect((await capability.plan!(ctx, input)).changeSet!.entries.map((e) => e.action)).toEqual(["no-op"]);
  }, 120_000);
});
