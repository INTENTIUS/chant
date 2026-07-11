import { describe, test, expect, vi } from "vitest";
import { stripMachineServerFields, stripAppServerFields, buildExportFromApp } from "./live-export";
import { FlyGenerator } from "./generator";
import { exportResources } from "../export-resources";
import type { FlapsMachine, FlyHttp } from "../op/activities/fly-apply";

const OWNED_META = { "managed-by": "chant" };

/** A live flaps machine as list/get returns it, carrying server-written fields. */
function liveMachine(name: string, image: string, owned = true): FlapsMachine {
  return {
    id: `m-${name}`,
    name,
    state: "started",
    instance_id: "INST0",
    private_ip: "fdaa::1",
    config: { image, metadata: owned ? { ...OWNED_META } : { role: "db" } },
  } as unknown as FlapsMachine;
}

/** A live app as GET /v1/apps/{app} returns it. */
function liveApp() {
  return {
    id: "app-1",
    name: "my-app",
    status: "deployed",
    machine_count: 1,
    volume_count: 0,
    internal_numeric_id: 42,
    organization: { slug: "acme" },
  };
}

describe("fly stripMachineServerFields", () => {
  test("drops server-written read-only fields, keeps config", () => {
    const cleaned = stripMachineServerFields(liveMachine("web", "nginx:1") as unknown as Record<string, unknown>);
    expect(cleaned.id).toBeUndefined();
    expect(cleaned.state).toBeUndefined();
    expect(cleaned.instance_id).toBeUndefined();
    expect(cleaned.private_ip).toBeUndefined();
    expect(cleaned.name).toBe("web");
    expect(cleaned.config).toEqual({ image: "nginx:1", metadata: { "managed-by": "chant" } });
  });

  test("does not mutate the input", () => {
    const input = liveMachine("web", "nginx:1") as unknown as Record<string, unknown>;
    stripMachineServerFields(input);
    expect(input.id).toBe("m-web");
  });
});

describe("fly stripAppServerFields", () => {
  test("drops read-only app fields and carries organization.slug into org_slug", () => {
    const cleaned = stripAppServerFields(liveApp() as unknown as Record<string, unknown>);
    expect(cleaned.id).toBeUndefined();
    expect(cleaned.status).toBeUndefined();
    expect(cleaned.machine_count).toBeUndefined();
    expect(cleaned.organization).toBeUndefined();
    expect(cleaned.name).toBe("my-app");
    expect(cleaned.org_slug).toBe("acme");
  });
});

describe("fly buildExportFromApp", () => {
  test("maps an app and its machines to export IR, stripped by default", () => {
    const ir = buildExportFromApp(liveApp(), [liveMachine("web", "nginx:1")]);
    expect(ir.resources.map((r) => r.type)).toEqual([
      "Fly::Machines::App",
      "Fly::Machines::Machine",
    ]);
    const machine = ir.resources.find((r) => r.type === "Fly::Machines::Machine")!;
    expect((machine.properties as Record<string, unknown>).id).toBeUndefined();
    expect(machine.properties.config).toEqual({ image: "nginx:1", metadata: { "managed-by": "chant" } });
    const app = ir.resources.find((r) => r.type === "Fly::Machines::App")!;
    expect(app.properties.org_slug).toBe("acme");
  });

  test("verbatim is inert: fly maps only the writable surface, so server fields never round-trip", () => {
    const ir = buildExportFromApp(liveApp(), [liveMachine("web", "nginx:1")], { verbatim: true });
    const machine = ir.resources.find((r) => r.type === "Fly::Machines::Machine")!;
    expect((machine.properties as Record<string, unknown>).id).toBeUndefined();
    expect((machine.properties as Record<string, unknown>).instance_id).toBeUndefined();
  });

  test("owned filter drops unmarked machines and keeps the app (it has a managed machine)", () => {
    const ir = buildExportFromApp(liveApp(), [liveMachine("web", "nginx:1", true), liveMachine("legacy", "redis:7", false)], { owned: true });
    const machines = ir.resources.filter((r) => r.type === "Fly::Machines::Machine");
    expect(machines.map((m) => m.logicalId)).toEqual(["web"]);
    expect(ir.resources.some((r) => r.type === "Fly::Machines::App")).toBe(true);
  });

  test("owned filter drops the app when no machine is chant-managed, and logs the boundary inference", () => {
    const onBoundaryInference = vi.fn();
    const ir = buildExportFromApp(liveApp(), [liveMachine("legacy", "redis:7", false)], { owned: true, onBoundaryInference });
    expect(ir.resources.some((r) => r.type === "Fly::Machines::App")).toBe(false);
    expect(ir.resources.some((r) => r.type === "Fly::Machines::Machine")).toBe(false);
    expect(onBoundaryInference).toHaveBeenCalled();
  });

  test("selector by type narrows the export", () => {
    const ir = buildExportFromApp(liveApp(), [liveMachine("web", "nginx:1")], {
      selector: { type: "Fly::Machines::Machine" },
    });
    expect(ir.resources.map((r) => r.type)).toEqual(["Fly::Machines::Machine"]);
  });

  test("export IR feeds FlyGenerator (templateGenerator) unchanged", () => {
    const ir = buildExportFromApp(liveApp(), [liveMachine("web", "nginx:1")]);
    const files = new FlyGenerator().generate(ir);
    expect(files[0].content).toContain("new Machine({");
  });
});

describe("fly exportResources (live I/O over injected flaps)", () => {
  const APP = "my-app";

  /** A fake flaps serving the app listing, one app GET, and one machine list. */
  function fakeHttp(machines: FlapsMachine[]): FlyHttp {
    return async (method, url) => {
      if (method === "GET" && url.includes("/v1/apps?org_slug=")) {
        return { status: 200, text: JSON.stringify({ apps: [{ name: APP }] }) };
      }
      if (method === "GET" && new RegExp(`/v1/apps/${APP}$`).test(url)) {
        return { status: 200, text: JSON.stringify(liveApp()) };
      }
      if (method === "GET" && url.endsWith("/machines")) {
        return { status: 200, text: JSON.stringify(machines) };
      }
      return { status: 404, text: "" };
    };
  }

  test("discovers the org's apps, lists machines, and returns the declared shape", async () => {
    const http = fakeHttp([liveMachine("web", "nginx:1")]);
    const ir = await exportResources({ environment: "prod" }, http);
    expect(ir.resources.map((r) => r.type)).toEqual([
      "Fly::Machines::App",
      "Fly::Machines::Machine",
    ]);
    const machine = ir.resources.find((r) => r.type === "Fly::Machines::Machine")!;
    expect((machine.properties as Record<string, unknown>).instance_id).toBeUndefined();
  });

  test("owned filter drops the foreign machine", async () => {
    const http = fakeHttp([liveMachine("web", "nginx:1", true), liveMachine("legacy", "redis:7", false)]);
    const ir = await exportResources({ environment: "prod", owned: true }, http);
    const machines = ir.resources.filter((r) => r.type === "Fly::Machines::Machine");
    expect(machines.map((m) => m.logicalId)).toEqual(["web"]);
  });
});
