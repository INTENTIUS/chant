import { describe, test, expect } from "vitest";
import { FlyParser } from "./parser";

const parser = new FlyParser();

describe("FlyParser", () => {
  test("empty input returns empty resources", () => {
    const ir = parser.parse("");
    expect(ir.resources).toEqual([]);
    expect(ir.parameters).toEqual([]);
  });

  test("serializer plan: /v1/apps body → App, app_name mapped to name", () => {
    const plan = JSON.stringify({
      app: { endpoint: "/v1/apps", method: "POST", body: { app_name: "my-app", org_slug: "personal" } },
    });
    const ir = parser.parse(plan);
    expect(ir.resources).toHaveLength(1);
    const app = ir.resources[0];
    expect(app.type).toBe("Fly::Machines::App");
    expect(app.logicalId).toBe("my-app");
    expect(app.properties.name).toBe("my-app");
    expect(app.properties.org_slug).toBe("personal");
    // The wire field name never leaks into the authoring surface.
    expect((app.properties as Record<string, unknown>).app_name).toBeUndefined();
  });

  test("serializer plan: machines endpoint → Machine with name/region/config", () => {
    const plan = JSON.stringify({
      web: {
        endpoint: "/v1/apps/my-app/machines",
        method: "POST",
        body: { name: "web", region: "iad", config: { image: "nginx:1" } },
      },
    });
    const ir = parser.parse(plan);
    expect(ir.resources).toHaveLength(1);
    const m = ir.resources[0];
    expect(m.type).toBe("Fly::Machines::Machine");
    expect(m.logicalId).toBe("web");
    expect(m.properties.name).toBe("web");
    expect(m.properties.region).toBe("iad");
    expect(m.properties.config).toEqual({ image: "nginx:1" });
  });

  test("serializer plan with an App and a Machine → both resources", () => {
    const plan = JSON.stringify({
      app: { endpoint: "/v1/apps", method: "POST", body: { app_name: "my-app" } },
      web: {
        endpoint: "/v1/apps/my-app/machines",
        method: "POST",
        body: { name: "web", region: "iad", config: { image: "nginx:1" } },
      },
    });
    const ir = parser.parse(plan);
    expect(ir.resources.map((r) => r.type)).toEqual([
      "Fly::Machines::App",
      "Fly::Machines::Machine",
    ]);
  });

  test("machines listing (array) → one Machine each", () => {
    const listing = JSON.stringify([
      { id: "m1", name: "web", region: "iad", state: "started", config: { image: "nginx:1" } },
      { id: "m2", name: "worker", region: "iad", state: "started", config: { image: "redis:7" } },
    ]);
    const ir = parser.parse(listing);
    expect(ir.resources.map((r) => r.logicalId)).toEqual(["web", "worker"]);
    expect(ir.resources.every((r) => r.type === "Fly::Machines::Machine")).toBe(true);
  });

  test("machine object strips server-written read-only fields", () => {
    const machine = JSON.stringify({
      id: "abc123",
      name: "web",
      region: "iad",
      state: "started",
      instance_id: "INST0",
      private_ip: "fdaa::1",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-02T00:00:00Z",
      nonce: "n1",
      events: [{ type: "start" }],
      checks: [{ status: "passing" }],
      host_status: "ok",
      image_ref: { tag: "latest" },
      incomplete_config: { image: "x" },
      config: { image: "nginx:1", metadata: { "managed-by": "chant" } },
    });
    const ir = parser.parse(machine);
    const props = ir.resources[0].properties;
    expect(props).toEqual({
      name: "web",
      region: "iad",
      config: { image: "nginx:1", metadata: { "managed-by": "chant" } },
    });
  });

  test("app-with-machines bundle → App plus its Machines", () => {
    const bundle = JSON.stringify({
      name: "my-app",
      org_slug: "personal",
      machines: [{ name: "web", region: "iad", config: { image: "nginx:1" } }],
    });
    const ir = parser.parse(bundle);
    expect(ir.resources.map((r) => r.type)).toEqual([
      "Fly::Machines::App",
      "Fly::Machines::Machine",
    ]);
    expect(ir.resources[0].properties.name).toBe("my-app");
  });

  test("app GET shape: name + organization.slug → App with org_slug", () => {
    const appGet = JSON.stringify({
      id: "app-1",
      name: "my-app",
      status: "deployed",
      machine_count: 2,
      organization: { slug: "acme" },
    });
    const ir = parser.parse(appGet);
    expect(ir.resources).toHaveLength(1);
    expect(ir.resources[0].type).toBe("Fly::Machines::App");
    expect(ir.resources[0].properties.name).toBe("my-app");
    expect(ir.resources[0].properties.org_slug).toBe("acme");
  });

  test("parameters are always empty (flaps has no template parameters)", () => {
    const ir = parser.parse(JSON.stringify({ app_name: "x" }));
    expect(ir.parameters).toEqual([]);
  });
});
