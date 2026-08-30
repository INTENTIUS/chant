import { afterEach, describe, expect, it } from "vitest";
import type { Declarable } from "@intentius/chant";
import { resolveAttrRefs } from "@intentius/chant/discovery/resolve";
import { serializeRender } from "./serializer";
import { describeResources } from "./describe-resources";
import { FakeRender } from "./op/activities/fake-render";
import { renderApply } from "./op/activities/render-apply";
import { WebService, WebServiceDetails, Postgres, Disk, CustomDomain, EnvGroup } from "./generated/index";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function stack(...entries: Array<[string, unknown]>): Map<string, Declarable> {
  return new Map(entries as Array<[string, Declarable]>);
}

function build(entities: Map<string, Declarable>): { buildOutput: string; entities: Map<string, { entityType: string; props: Record<string, unknown> }> } {
  resolveAttrRefs(entities);
  const buildOutput = serializeRender(entities);
  const meta = new Map<string, { entityType: string; props: Record<string, unknown> }>();
  for (const [name, e] of entities) {
    meta.set(name, { entityType: (e as unknown as { entityType: string }).entityType, props: (e as unknown as { props: Record<string, unknown> }).props ?? {} });
  }
  return { buildOutput, entities: meta };
}

const base = (b: ReturnType<typeof build>) => ({
  environment: "dev",
  buildOutput: b.buildOutput,
  entityNames: [...b.entities.keys()],
  entities: b.entities,
  endpoint: "http://fake/v1",
});

describe("render describeResources", () => {
  afterEach(() => {
    delete process.env.RENDER_OWNER_ID;
  });

  it("reports absent before apply and present (with verdicts) after", async () => {
    process.env.RENDER_OWNER_ID = "tea-1";
    const fake = new FakeRender();
    const w = new WebService({ name: "web", serviceDetails: new WebServiceDetails({ runtime: "docker" }) });
    const b = build(stack(["web", w], ["db", new Postgres({ name: "db", plan: "free", version: "16" })], ["disk", new Disk({ name: "data", sizeGB: 1, mountPath: "/d", serviceId: w })]));

    const before = await describeResources(base(b), fake.http());
    expect(before.observation).toBe("v1");
    expect(before.resources).toEqual({});
    expect(before.unobserved).toBeUndefined();

    const dir = mkdtempSync(join(tmpdir(), "render-obs-"));
    const planPath = join(dir, "render.json");
    writeFileSync(planPath, b.buildOutput);
    await renderApply({ planPath, endpoint: "http://fake/v1", wait: { intervalMs: 0 } }, undefined, fake.http());

    const after = await describeResources(base(b), fake.http());
    expect(Object.keys(after.resources).sort()).toEqual(["db", "disk", "web"]);
    expect(after.resources.web.ownership).toBe("owned");
    expect(after.resources.web.type).toBe("Render::Services::WebService");
    expect(after.resources.web.physicalId).toMatch(/^srv-/);
    expect(after.resources.db.ownership).toBe("unknown");
    // Service boundary: the disk inherits its owned parent's verdict.
    expect(after.resources.disk.ownership).toBe("owned");
    expect(after.resources.disk.attributes?.serviceId).toBe(after.resources.web.physicalId);
  });

  it("disks and domains inherit a foreign parent's verdict, and undeclared ones under an owned service are owned orphans", async () => {
    process.env.RENDER_OWNER_ID = "tea-1";
    const fake = new FakeRender();
    const foreign = fake.seed("/services", { name: "theirs", type: "web_service", ownerId: "tea-1", envVars: [] });
    fake.seed("/disks", { name: "fd", sizeGB: 1, mountPath: "/d", serviceId: foreign.id });
    const w = new WebService({ name: "web", serviceDetails: new WebServiceDetails({ runtime: "docker" }) });
    const b = build(
      stack(
        ["web", w],
        ["disk", new Disk({ name: "data", sizeGB: 1, mountPath: "/d", serviceId: w })],
        ["fdisk", new Disk({ name: "fd", sizeGB: 1, mountPath: "/d", serviceId: foreign.id as string })],
      ),
    );
    const dir = mkdtempSync(join(tmpdir(), "render-obs-"));
    const planPath = join(dir, "render.json");
    writeFileSync(planPath, b.buildOutput);
    await renderApply({ planPath, endpoint: "http://fake/v1", wait: { intervalMs: 0 } }, undefined, fake.http());
    const webId = fake.service("web")!.id as string;
    fake.seed("/disks", { name: "stray", sizeGB: 1, mountPath: "/s", serviceId: webId });
    fake.domains.set(webId, [{ id: "cd-1", name: "stray.example.com", verificationStatus: "unverified" }]);

    const out = await describeResources(base(b), fake.http());
    expect(out.resources.disk.ownership).toBe("owned");
    expect(out.resources.fdisk.ownership).toBe("foreign");
    expect(out.resources["Disk/stray"]).toMatchObject({ ownership: "owned", type: "Render::Services::Disk" });
    expect(out.resources["CustomDomain/stray.example.com"]).toMatchObject({ ownership: "owned", status: "unverified" });

    const owned = await describeResources({ ...base(b), owned: true }, fake.http());
    expect(owned.resources.fdisk).toBeUndefined();
    expect(owned.unobserved?.fdisk.reason).toBe("filtered");
    expect(owned.resources.disk.ownership).toBe("owned");
  });

  it("marks an unmarked live service foreign, and withholds it under --owned", async () => {
    process.env.RENDER_OWNER_ID = "tea-1";
    const fake = new FakeRender();
    fake.seed("/services", { name: "web", type: "web_service", ownerId: "tea-1", envVars: [{ key: "A", value: "1" }] });
    const b = build(stack(["web", new WebService({ name: "web", serviceDetails: new WebServiceDetails({ runtime: "docker" }) })]));

    const all = await describeResources(base(b), fake.http());
    expect(all.resources.web.ownership).toBe("foreign");

    const owned = await describeResources({ ...base(b), owned: true }, fake.http());
    expect(owned.resources.web).toBeUndefined();
    expect(owned.unobserved?.web.reason).toBe("filtered");
  });

  it("returns undeclared chant-marked services and env groups as owned orphans", async () => {
    process.env.RENDER_OWNER_ID = "tea-1";
    const fake = new FakeRender();
    fake.seed("/services", { name: "stale", type: "cron_job", ownerId: "tea-1", envVars: [{ key: "CHANT_MANAGED_BY", value: "chant" }] });
    fake.seed("/services", { name: "theirs", type: "web_service", ownerId: "tea-1", envVars: [] });
    fake.seed("/env-groups", { name: "old", ownerId: "tea-1", envVars: [{ key: "CHANT_MANAGED_BY", value: "chant" }] });
    const b = build(stack(["g", new EnvGroup({ name: "g", envVars: [] })]));

    const out = await describeResources(base(b), fake.http());
    expect(Object.keys(out.resources).sort()).toEqual(["CronJob/stale", "EnvGroup/old"]);
    expect(out.resources["CronJob/stale"].ownership).toBe("owned");
    expect(out.resources["CronJob/stale"].type).toBe("Render::Services::CronJob");
  });

  it("with no build output, every declared entity is unobserved (read-failed), not absent", async () => {
    const fake = new FakeRender();
    const b = build(stack(["web", new WebService({ name: "web", serviceDetails: new WebServiceDetails({ runtime: "docker" }) })]));
    const out = await describeResources({ ...base(b), buildOutput: "" }, fake.http());
    expect(out.resources).toEqual({});
    expect(out.unobserved?.web.reason).toBe("read-failed");
  });

  it("an owner that cannot be resolved is no-credentials for every entity", async () => {
    const fake = new FakeRender();
    fake.owners.push({ id: "tea-2", name: "B", email: "", type: "team" });
    const b = build(stack(["web", new WebService({ name: "web", serviceDetails: new WebServiceDetails({ runtime: "docker" }) })]));
    const out = await describeResources(base(b), fake.http());
    expect(out.unobserved?.web.reason).toBe("no-credentials");
  });
});
