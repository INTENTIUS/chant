/**
 * `gcp-apply`'s plan and apply against floci-gcp (#4273), over real HTTP.
 * Set CHANT_FLOCI_GCP_ENDPOINT to a running floci-gcp, for example
 * `docker run -d -p 4688:4588 floci/floci-gcp:0.5.0` and
 * `CHANT_FLOCI_GCP_ENDPOINT=http://localhost:4688`. Skipped without it.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gcpDelete } from "../op/activities/gcp-apply";
import { createGcpApplyCapability, GcpPlanMovedError } from "./gcp-apply";

const endpoint = process.env.CHANT_FLOCI_GCP_ENDPOINT;

describe.skipIf(!endpoint)("gcp-apply plan against floci-gcp (#4273)", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const ctx = { env: "local", component: "gcp-e2e" };
  const saved = { ...process.env };
  let dir: string;
  let manifest: string;
  const bucket = (storageClass: string) => ({
    apiVersion: "storage.cnrm.cloud.google.com/v1beta1",
    kind: "StorageBucket",
    metadata: { name: `chant-plan-${suffix}` },
    spec: { location: "US", storageClass },
  });
  const topic = { apiVersion: "pubsub.cnrm.cloud.google.com/v1beta1", kind: "PubSubTopic", metadata: { name: `chant-plan-${suffix}` }, spec: {} };
  const write = (resources: unknown[]): void => writeFileSync(manifest, JSON.stringify(resources));

  beforeAll(() => {
    Object.assign(process.env, { GCP_ENDPOINT_URL: endpoint, GCP_PROJECT_ID: "floci-local" });
    dir = mkdtempSync(join(tmpdir(), "gcp-apply-floci-"));
    manifest = join(dir, "manifest.json");
  });

  afterAll(async () => {
    try {
      write([bucket("STANDARD"), topic]);
      await gcpDelete({ manifestPath: manifest });
    } finally {
      process.env = saved;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("plans a create, applies it, plans no change, plans an update and refuses a plan the manifest moved past", async () => {
    const capability = createGcpApplyCapability();

    write([bucket("STANDARD"), topic]);
    const created = await capability.plan!(ctx, { manifest });
    expect(created.changeSet!.entries.map((e) => [e.type, e.action])).toEqual([
      ["PubSubTopic", "create"],
      ["StorageBucket", "create"],
    ]);
    const first = await capability.run({ ...ctx, plans: { [ctx.component]: created.artifact } }, { manifest });
    expect(first.applied.map((a) => a.created)).toEqual([true, true]);

    const same = await capability.plan!(ctx, { manifest });
    expect(same.changeSet!.entries.map((e) => e.action)).toEqual(["no-op", "no-op"]);
    expect(same.changeSet!.member.holes).toEqual([]);

    write([bucket("NEARLINE"), topic]);
    const updated = await capability.plan!(ctx, { manifest });
    expect(updated.changeSet!.entries.filter((e) => e.action !== "no-op").map((e) => [e.type, e.action, e.attributes.map((a) => a.path)])).toEqual([
      ["StorageBucket", "update", ["storageClass"]],
    ]);

    write([bucket("COLDLINE"), topic]);
    await expect(capability.run({ ...ctx, plans: { [ctx.component]: updated.artifact } }, { manifest })).rejects.toBeInstanceOf(GcpPlanMovedError);

    write([bucket("NEARLINE"), topic]);
    const second = await capability.run({ ...ctx, plans: { [ctx.component]: updated.artifact } }, { manifest });
    expect(second.applied.find((a) => a.kind === "StorageBucket")).toMatchObject({ created: false, updated: true });

    const after = await capability.plan!(ctx, { manifest });
    expect(after.changeSet!.entries.map((e) => e.action)).toEqual(["no-op", "no-op"]);
  }, 120_000);
});
