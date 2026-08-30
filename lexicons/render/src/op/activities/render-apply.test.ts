import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Declarable } from "@intentius/chant";
import { resolveAttrRefs } from "@intentius/chant/discovery/resolve";
import { serializeRender } from "../../serializer";
import { CATALOG, ENTITY_TYPES } from "../../catalog";
import {
  WebService,
  WebServiceDetails,
  NativeEnvironmentDetails,
  Postgres,
  EnvGroup,
  Project,
  ProjectEnvironment,
  Environment,
  Disk,
  CustomDomain,
  BackgroundWorker,
  BackgroundWorkerDetails,
} from "../../generated/index";
import { FakeRender } from "./fake-render";
import {
  renderApply,
  renderApplyDetailed,
  renderDelete,
  orderPlan,
  diffForPatch,
  envVarsDiffer,
  isChantOwned,
  inStack,
  planOwnership,
  resolveEndpoint,
  resolveOwner,
  waitForDeploy,
  type RenderHttp,
} from "./render-apply";

function stack(...entries: Array<[string, unknown]>): Map<string, Declarable> {
  return new Map(entries as Array<[string, Declarable]>);
}

/** Serialize a stack to a plan file and return its path. */
function planFile(entities: Map<string, Declarable>, ownership?: { stack: string; env?: string }): string {
  resolveAttrRefs(entities);
  const dir = mkdtempSync(join(tmpdir(), "render-plan-"));
  const path = join(dir, "render.json");
  writeFileSync(path, serializeRender(entities, undefined, ownership ? { ownership } : undefined));
  return path;
}

const web = () =>
  new WebService({
    name: "web",
    repo: "https://github.com/render-examples/express-hello-world",
    serviceDetails: new WebServiceDetails({
      runtime: "node",
      plan: "starter",
      envSpecificDetails: new NativeEnvironmentDetails({ buildCommand: "npm ci", startCommand: "npm start" }),
    }),
    envVars: [{ key: "LOG_LEVEL", value: "info" }],
  });

describe("render-apply pure helpers", () => {
  afterEach(() => {
    delete process.env.RENDER_API_BASE_URL;
    delete process.env.RENDER_OWNER_ID;
  });

  it("resolveEndpoint: arg > env > default, trailing slash stripped", () => {
    expect(resolveEndpoint({}, {})).toBe("https://api.render.com/v1");
    expect(resolveEndpoint({}, { RENDER_API_BASE_URL: "http://localhost:9999/v1/" })).toBe("http://localhost:9999/v1");
    expect(resolveEndpoint({ endpoint: "http://x/" }, { RENDER_API_BASE_URL: "http://y" })).toBe("http://x");
  });

  it("orderPlan: catalog order first, then references", () => {
    const db = new Postgres({ name: "db", plan: "free", version: "16" });
    const project = new Project({ name: "p", environments: [] });
    const env = new Environment({ name: "prod", projectId: project });
    const w = new WebService({
      name: "web",
      environmentId: env,
      serviceDetails: new WebServiceDetails({ runtime: "docker" }),
      envVars: [{ key: "DATABASE_URL", value: db.internalConnectionString }],
    });
    const entities = stack(["web", w], ["disk", new Disk({ name: "d", sizeGB: 1, mountPath: "/d", serviceId: w })], ["db", db], ["env", env], ["project", project]);
    resolveAttrRefs(entities);
    const plan = JSON.parse(serializeRender(entities));
    expect(orderPlan(plan).map(([n]) => n)).toEqual(["project", "env", "db", "web", "disk"]);
  });

  it("orderPlan: a dangling reference is an error", () => {
    expect(() =>
      orderPlan({
        d: { kind: "Disk", entityType: ENTITY_TYPES.disk, endpoint: "/disks", method: "POST", name: "d", body: { serviceId: { $ref: "nope" } } },
      }),
    ).toThrow(/references "nope"/);
  });

  it("diffForPatch: only declared patchable fields that differ; nested subset compare", () => {
    const entry = CATALOG[ENTITY_TYPES.webService];
    const live = { name: "web", ownerId: "tea-1", branch: "main", serviceDetails: { runtime: "node", plan: "starter", numInstances: 1, region: "oregon" } };
    expect(diffForPatch(entry, { name: "web", ownerId: "tea-2", branch: "main", serviceDetails: { runtime: "node", plan: "starter" } }, live)).toBeUndefined();
    expect(diffForPatch(entry, { branch: "dev" }, live)).toEqual({ branch: "dev" });
    expect(diffForPatch(entry, { serviceDetails: { plan: "standard" } }, live)).toEqual({ serviceDetails: { plan: "standard" } });
  });

  it("envVarsDiffer: generated values match anything; key sets and values compared", () => {
    expect(envVarsDiffer([{ key: "A", value: "1" }], { A: "1" })).toBe(false);
    expect(envVarsDiffer([{ key: "A", value: "2" }], { A: "1" })).toBe(true);
    expect(envVarsDiffer([{ key: "A", generateValue: true }], { A: "whatever" })).toBe(false);
    expect(envVarsDiffer([{ key: "A", value: "1" }, { key: "B", value: "2" }], { A: "1" })).toBe(true);
  });

  it("ownership: marker detection and stack scoping", () => {
    expect(isChantOwned({ CHANT_MANAGED_BY: "chant" })).toBe(true);
    expect(isChantOwned({ CHANT_MANAGED_BY: "terraform" })).toBe(false);
    expect(isChantOwned({})).toBe(false);
    expect(inStack({ stack: "a" }, undefined)).toBe(true);
    expect(inStack({ stack: "a" }, { stack: "" })).toBe(true);
    expect(inStack({ stack: "a" }, { stack: "b" })).toBe(false);
    expect(inStack({ stack: "a", env: "prod" }, { stack: "a", env: "dev" })).toBe(false);
    expect(inStack(undefined, { stack: "a" })).toBe(false);
    const plan = JSON.parse(serializeRender(stack(["web", web()]), undefined, { ownership: { stack: "shop", env: "prod" } }));
    expect(planOwnership(plan)).toEqual({ stack: "shop", env: "prod" });
  });

  it("resolveOwner: arg, env, sole visible owner, else error", async () => {
    const fake = new FakeRender();
    const ctx = { base: "http://fake/v1" };
    expect(await resolveOwner(ctx, { ownerId: "tea-x" }, fake.http(), undefined, {})).toBe("tea-x");
    expect(await resolveOwner({ base: "http://fake/v1" }, {}, fake.http(), undefined, { RENDER_OWNER_ID: "tea-env" })).toBe("tea-env");
    expect(await resolveOwner({ base: "http://fake/v1" }, {}, fake.http(), undefined, {})).toBe("tea-1");
    fake.owners.push({ id: "tea-2", name: "Other", email: "", type: "team" });
    await expect(resolveOwner({ base: "http://fake/v1" }, {}, fake.http(), undefined, {})).rejects.toThrow(/2 workspaces/);
  });

  it("waitForDeploy: polls to live, throws on failure", async () => {
    const fake = new FakeRender();
    const svc = fake.seed("/services", { name: "s", type: "web_service", ownerId: "tea-1" });
    const id = svc.id as string;
    fake.deploys.set(id, [{ id: "dep-1", status: "build_in_progress" }]);
    fake.deployPolls = 2;
    let t = 0;
    const status = await waitForDeploy({ base: "http://fake/v1" }, id, "dep-1", { intervalMs: 0 }, fake.http(), undefined, () => (t += 1000));
    expect(status).toBe("live");

    fake.deploys.set(id, [{ id: "dep-2", status: "build_failed" }]);
    await expect(waitForDeploy({ base: "http://fake/v1" }, id, "dep-2", { intervalMs: 0 }, fake.http())).rejects.toThrow(/build_failed/);
  });
});

describe("renderApply against the fake API", () => {
  afterEach(() => {
    delete process.env.RENDER_OWNER_ID;
  });

  it("creates a full stack in dependency order, resolving refs, attrs, and the owner", async () => {
    const fake = new FakeRender();
    const db = new Postgres({ name: "db", plan: "free", version: "16" });
    const project = new Project({ name: "shop", environments: [new ProjectEnvironment({ name: "prod" })] });
    const env = new Environment({ name: "prod", projectId: project });
    const w = new WebService({
      name: "web",
      environmentId: env,
      serviceDetails: new WebServiceDetails({ runtime: "docker" }),
      envVars: [{ key: "DATABASE_URL", value: db.internalConnectionString }, { key: "SECRET", generateValue: true }],
    });
    const group = new EnvGroup({ name: "shared", envVars: [{ key: "A", value: "1" }], serviceIds: [w] });
    const path = planFile(
      stack(
        ["group", group],
        ["domain", new CustomDomain({ name: "example.com", serviceId: w })],
        ["disk", new Disk({ name: "data", sizeGB: 5, mountPath: "/data", serviceId: w })],
        ["web", w],
        ["db", db],
        ["env", env],
        ["project", project],
      ),
      { stack: "shop" },
    );

    const result = await renderApply({ planPath: path, endpoint: "http://fake/v1", wait: { intervalMs: 0 } }, undefined, fake.http());

    expect(result.apply).toBe("v1");
    expect(result.applied.map((a) => `${a.kind}/${a.name}:${a.action}`)).toEqual([
      "Project/shop:created",
      "Environment/prod:created",
      "Postgres/db:created",
      "WebService/web:created",
      "EnvGroup/shared:created",
      "CustomDomain/example.com:created",
      "Disk/data:created",
    ]);

    // Owner resolved from the sole visible workspace.
    const svc = fake.service("web")!;
    expect(svc.ownerId).toBe("tea-1");
    // Environment got the project's live id; the service got the environment's.
    const envRec = [...fake.collections["/environments"].items.values()][0];
    const prjRec = [...fake.collections["/projects"].items.values()][0];
    expect(envRec.projectId).toBe(prjRec.id);
    expect(svc.environmentId).toBe(envRec.id);
    // The connection string was read from /connection-info; the marker was stamped.
    expect(fake.serviceEnv.get(svc.id as string)).toEqual([
      { key: "DATABASE_URL", value: "internal://db" },
      { key: "SECRET", value: "gen-SECRET" },
      { key: "CHANT_MANAGED_BY", value: "chant" },
      { key: "CHANT_STACK", value: "shop" },
    ]);
    // Disk and domain hang off the live service id.
    const disk = [...fake.collections["/disks"].items.values()][0];
    expect(disk.serviceId).toBe(svc.id);
    expect(fake.domains.get(svc.id as string)?.[0].name).toBe("example.com");
    // Env group linked to the service.
    const grp = [...fake.collections["/env-groups"].items.values()][0];
    expect((grp.serviceLinks as Array<{ id: string }>).map((l) => l.id)).toEqual([svc.id]);
    // The created service's deploy was awaited.
    expect(fake.calls.some((c) => c.method === "GET" && /\/deploys\//.test(c.path))).toBe(true);
  });

  it("is idempotent: a second apply is all unchanged, and a changed field is a PATCH", async () => {
    const fake = new FakeRender();
    process.env.RENDER_OWNER_ID = "tea-1";
    const first = planFile(stack(["web", web()]));
    await renderApply({ planPath: first, endpoint: "http://fake/v1", wait: { intervalMs: 0 } }, undefined, fake.http());
    fake.calls.length = 0;

    const again = await renderApply({ planPath: first, endpoint: "http://fake/v1", wait: { intervalMs: 0 } }, undefined, fake.http());
    expect(again.applied).toEqual([{ kind: "WebService", name: "web", action: "unchanged", physicalId: fake.service("web")!.id }]);
    expect(fake.calls.filter((c) => c.method !== "GET")).toEqual([]);

    const changed = planFile(
      stack([
        "web",
        new WebService({
          name: "web",
          repo: "https://github.com/render-examples/express-hello-world",
          branch: "release",
          serviceDetails: new WebServiceDetails({ runtime: "node", plan: "standard" }),
          envVars: [{ key: "LOG_LEVEL", value: "debug" }],
        }),
      ]),
    );
    const updated = await renderApply({ planPath: changed, endpoint: "http://fake/v1", wait: { intervalMs: 0 } }, undefined, fake.http());
    expect(updated.applied[0].action).toBe("updated");
    const svc = fake.service("web")!;
    expect(svc.branch).toBe("release");
    expect((svc.serviceDetails as { plan: string }).plan).toBe("standard");
    expect(fake.serviceEnv.get(svc.id as string)).toEqual([
      { key: "LOG_LEVEL", value: "debug" },
      { key: "CHANT_MANAGED_BY", value: "chant" },
    ]);
    const patchCall = fake.calls.find((c) => c.method === "PATCH");
    expect(patchCall?.body).toEqual({ branch: "release", serviceDetails: { runtime: "node", plan: "standard" } });
  });

  it("keeps a generated env var's live value on update instead of regenerating it", async () => {
    const fake = new FakeRender();
    process.env.RENDER_OWNER_ID = "tea-1";
    const mk = (extra: string) =>
      new WebService({
        name: "web",
        serviceDetails: new WebServiceDetails({ runtime: "docker" }),
        envVars: [{ key: "SECRET", generateValue: true }, { key: "X", value: extra }],
      });
    await renderApply({ planPath: planFile(stack(["web", mk("1")])), endpoint: "http://fake/v1", wait: { intervalMs: 0 } }, undefined, fake.http());
    const id = fake.service("web")!.id as string;
    fake.serviceEnv.set(id, [{ key: "SECRET", value: "s3cr3t" }, { key: "X", value: "1" }, { key: "CHANT_MANAGED_BY", value: "chant" }]);
    await renderApply({ planPath: planFile(stack(["web", mk("2")])), endpoint: "http://fake/v1", wait: { intervalMs: 0 } }, undefined, fake.http());
    expect(fake.serviceEnv.get(id)).toEqual([
      { key: "SECRET", value: "s3cr3t" },
      { key: "X", value: "2" },
      { key: "CHANT_MANAGED_BY", value: "chant" },
    ]);
  });

  it("prunes only chant-owned services of this stack, never foreign or other-stack ones", async () => {
    const fake = new FakeRender();
    process.env.RENDER_OWNER_ID = "tea-1";
    fake.seed("/services", { name: "foreign", type: "web_service", ownerId: "tea-1", envVars: [{ key: "A", value: "1" }] });
    fake.seed("/services", { name: "other-stack", type: "web_service", ownerId: "tea-1", envVars: [{ key: "CHANT_MANAGED_BY", value: "chant" }, { key: "CHANT_STACK", value: "other" }] });
    fake.seed("/services", { name: "stale", type: "background_worker", ownerId: "tea-1", envVars: [{ key: "CHANT_MANAGED_BY", value: "chant" }, { key: "CHANT_STACK", value: "shop" }] });
    fake.seed("/env-groups", { name: "stale-group", ownerId: "tea-1", envVars: [{ key: "CHANT_MANAGED_BY", value: "chant" }, { key: "CHANT_STACK", value: "shop" }] });
    fake.seed("/env-groups", { name: "foreign-group", ownerId: "tea-1", envVars: [{ key: "B", value: "2" }] });

    const path = planFile(stack(["web", web()]), { stack: "shop" });
    const result = await renderApply({ planPath: path, endpoint: "http://fake/v1", prune: true, wait: { intervalMs: 0 } }, undefined, fake.http());

    expect(result.pruned?.map((p) => `${p.kind}/${p.name}`)).toEqual(["BackgroundWorker/stale", "EnvGroup/stale-group"]);
    expect(fake.service("foreign")).toBeDefined();
    expect(fake.service("other-stack")).toBeDefined();
    expect(fake.service("stale")).toBeUndefined();
    expect([...fake.collections["/env-groups"].items.values()].map((g) => g.name)).toEqual(["foreign-group"]);
  });

  it("prunes undeclared disks and custom domains under an owned declared service, never under a foreign one", async () => {
    const fake = new FakeRender();
    process.env.RENDER_OWNER_ID = "tea-1";
    // First apply: web + two disks + two domains.
    const w1 = web();
    const first = planFile(
      stack(
        ["web", w1],
        ["data", new Disk({ name: "data", sizeGB: 1, mountPath: "/data", serviceId: w1 })],
        ["old", new Disk({ name: "old", sizeGB: 1, mountPath: "/old", serviceId: w1 })],
        ["apex", new CustomDomain({ name: "example.com", serviceId: w1 })],
        ["www", new CustomDomain({ name: "www.example.com", serviceId: w1 })],
      ),
    );
    await renderApply({ planPath: first, endpoint: "http://fake/v1", wait: { intervalMs: 0 } }, undefined, fake.http());
    // A foreign service with a disk and a domain of its own.
    const foreign = fake.seed("/services", { name: "theirs", type: "web_service", ownerId: "tea-1", envVars: [] });
    fake.seed("/disks", { name: "theirs-data", sizeGB: 1, mountPath: "/d", serviceId: foreign.id });
    fake.domains.set(foreign.id as string, [{ id: "cd-theirs", name: "theirs.example.com" }]);

    // Second apply drops `old` and `www`.
    const w2 = web();
    const second = planFile(
      stack(
        ["web", w2],
        ["data", new Disk({ name: "data", sizeGB: 1, mountPath: "/data", serviceId: w2 })],
        ["apex", new CustomDomain({ name: "example.com", serviceId: w2 })],
      ),
    );
    const result = await renderApply({ planPath: second, endpoint: "http://fake/v1", prune: true, wait: { intervalMs: 0 } }, undefined, fake.http());
    expect(result.pruned?.map((p) => `${p.kind}/${p.name}`).sort()).toEqual(["CustomDomain/www.example.com", "Disk/old"]);
    const webId = fake.service("web")!.id as string;
    expect([...fake.collections["/disks"].items.values()].map((d) => d.name).sort()).toEqual(["data", "theirs-data"]);
    expect(fake.domains.get(webId)?.map((d) => d.name)).toEqual(["example.com"]);
    expect(fake.domains.get(foreign.id as string)?.map((d) => d.name)).toEqual(["theirs.example.com"]);
  });

  it("does not prune without the flag", async () => {
    const fake = new FakeRender();
    process.env.RENDER_OWNER_ID = "tea-1";
    fake.seed("/services", { name: "stale", type: "web_service", ownerId: "tea-1", envVars: [{ key: "CHANT_MANAGED_BY", value: "chant" }] });
    const result = await renderApply({ planPath: planFile(stack(["web", web()])), endpoint: "http://fake/v1", wait: { intervalMs: 0 } }, undefined, fake.http());
    expect(result.pruned).toBeUndefined();
    expect(fake.service("stale")).toBeDefined();
  });

  it("matches services by name AND type, so a same-named worker is not mistaken for the web service", async () => {
    const fake = new FakeRender();
    process.env.RENDER_OWNER_ID = "tea-1";
    fake.seed("/services", {
      name: "app",
      type: "background_worker",
      ownerId: "tea-1",
      serviceDetails: { runtime: "docker" },
      envVars: [{ key: "CHANT_MANAGED_BY", value: "chant" }],
    });
    const path = planFile(
      stack(
        ["w", new WebService({ name: "app", serviceDetails: new WebServiceDetails({ runtime: "docker" }) })],
        ["bg", new BackgroundWorker({ name: "app", serviceDetails: new BackgroundWorkerDetails({ runtime: "docker" }) })],
      ),
    );
    const result = await renderApply({ planPath: path, endpoint: "http://fake/v1", wait: { intervalMs: 0 } }, undefined, fake.http());
    expect(result.applied.map((a) => `${a.kind}:${a.action}`)).toEqual(["WebService:created", "BackgroundWorker:unchanged"]);
  });

  it("renderDelete removes what the plan names in reverse order and reports already-gone", async () => {
    const fake = new FakeRender();
    process.env.RENDER_OWNER_ID = "tea-1";
    const w = web();
    const entities = stack(["web", w], ["disk", new Disk({ name: "data", sizeGB: 1, mountPath: "/data", serviceId: w })], ["domain", new CustomDomain({ name: "example.com", serviceId: w })]);
    const path = planFile(entities);
    await renderApply({ planPath: path, endpoint: "http://fake/v1", wait: { intervalMs: 0 } }, undefined, fake.http());
    fake.calls.length = 0;

    const result = await renderDelete({ planPath: path, endpoint: "http://fake/v1" }, undefined, fake.http());
    expect(result.pruned?.map((p) => `${p.kind}/${p.name}:${p.deleted}`)).toEqual([
      "CustomDomain/example.com:true",
      "Disk/data:true",
      "WebService/web:true",
    ]);
    expect(fake.calls.filter((c) => c.method === "DELETE").map((c) => c.path.replace(/-\d+/g, ""))).toEqual([
      "/services/srv/custom-domains/cd",
      "/disks/dsk",
      "/services/srv",
    ]);

    const again = await renderDelete({ planPath: path, endpoint: "http://fake/v1" }, undefined, fake.http());
    expect(again.pruned?.every((p) => p.deleted === false)).toBe(true);
  });

  it("surfaces an API error with status and body", async () => {
    const http: RenderHttp = async (method) =>
      method === "GET" ? { status: 200, text: "[]" } : { status: 402, text: '{"message":"payment required"}' };
    process.env.RENDER_OWNER_ID = "tea-1";
    const path = planFile(stack(["web", web()]));
    await expect(renderApply({ planPath: path, endpoint: "http://fake/v1" }, undefined, http)).rejects.toThrow(/POST \/services failed \(HTTP 402\).*payment required/);
  });

  it("renderApplyDetailed exposes entity names alongside the envelope", async () => {
    const fake = new FakeRender();
    process.env.RENDER_OWNER_ID = "tea-1";
    const out = await renderApplyDetailed({ planPath: planFile(stack(["site", web()])), endpoint: "http://fake/v1", wait: { intervalMs: 0 } }, undefined, fake.http());
    expect(out.applied[0]).toMatchObject({ entity: "site", kind: "WebService", name: "web", action: "created" });
  });
});
