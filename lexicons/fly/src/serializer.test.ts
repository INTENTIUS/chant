import { describe, expect, it } from "vitest";
import type { Declarable } from "@intentius/chant";
import { flySerializer } from "./serializer";
import { App, Machine, MachineConfig, MachineGuest } from "./generated/index";

/** Author a map of declarables keyed by logical name, in insertion order. */
function stack(...entries: Array<[string, unknown]>): Map<string, Declarable> {
  return new Map(entries as Array<[string, Declarable]>);
}

describe("fly serializer", () => {
  it("serializes an empty map to valid JSON", () => {
    const result = flySerializer.serialize(new Map());
    expect(typeof result).toBe("string");
    expect(JSON.parse(result)).toEqual({});
  });

  it("has the correct name and rule prefix", () => {
    expect(flySerializer.name).toBe("fly");
    expect(flySerializer.rulePrefix).toBe("FLY");
  });

  it("emits the App create body with app_name/org_slug (flaps CreateAppRequest)", () => {
    const entities = stack([
      "web",
      new App({ name: "my-app", org_slug: "acme" }),
    ]);

    const out = JSON.parse(flySerializer.serialize(entities));
    expect(out.web).toEqual({
      endpoint: "/v1/apps",
      method: "POST",
      body: { app_name: "my-app", org_slug: "acme" },
    });
  });

  it("falls back to the entity name for app_name when no explicit name", () => {
    const out = JSON.parse(flySerializer.serialize(stack(["billing", new App({ org_slug: "acme" })])));
    expect(out.billing.body.app_name).toBe("billing");
  });

  it("emits the Machine create body with config image/guest and endpoints the owning app", () => {
    const entities = stack(
      ["app", new App({ name: "my-app", org_slug: "acme" })],
      [
        "api",
        new Machine({
          name: "api-1",
          region: "iad",
          config: new MachineConfig({
            image: "flyio/hellofly:latest",
            guest: new MachineGuest({ cpu_kind: "shared", cpus: 1, memory_mb: 256 }),
            env: { LOG_LEVEL: "info" },
          }),
        }),
      ],
    );

    const out = JSON.parse(flySerializer.serialize(entities));
    expect(out.api.endpoint).toBe("/v1/apps/my-app/machines");
    expect(out.api.method).toBe("POST");
    expect(out.api.body.name).toBe("api-1");
    expect(out.api.body.region).toBe("iad");
    expect(out.api.body.config.image).toBe("flyio/hellofly:latest");
    expect(out.api.body.config.guest).toEqual({ cpu_kind: "shared", cpus: 1, memory_mb: 256 });
    expect(out.api.body.config.env).toEqual({ LOG_LEVEL: "info" });
  });

  it("stamps managed-by: chant on every machine, including one with no metadata", () => {
    const entities = stack(
      ["app", new App({ name: "my-app" })],
      ["bare", new Machine({ config: new MachineConfig({ image: "nginx" }) })],
      [
        "withMeta",
        new Machine({
          config: new MachineConfig({ image: "nginx", metadata: { role: "cache" } }),
        }),
      ],
    );

    const out = JSON.parse(flySerializer.serialize(entities));
    // No user metadata → marker still present.
    expect(out.bare.body.config.metadata["managed-by"]).toBe("chant");
    // User metadata is preserved and the marker is merged in.
    expect(out.withMeta.body.config.metadata["managed-by"]).toBe("chant");
    expect(out.withMeta.body.config.metadata.role).toBe("cache");
  });

  it("stamps the stack/env ownership identity when context.ownership is passed", () => {
    const entities = stack(
      ["app", new App({ name: "my-app" })],
      ["api", new Machine({ config: new MachineConfig({ image: "nginx" }) })],
    );

    const out = JSON.parse(
      flySerializer.serialize(entities, undefined, { ownership: { stack: "billing", env: "prod" } }),
    );
    const meta = out.api.body.config.metadata;
    expect(meta["managed-by"]).toBe("chant");
    expect(meta["chant-stack"]).toBe("billing");
    expect(meta["chant-env"]).toBe("prod");
  });

  it("matches the mudflaps CreateMachineRequest field names (name/region/config)", () => {
    const entities = stack(
      ["app", new App({ name: "my-app" })],
      [
        "api",
        new Machine({ name: "api-1", region: "iad", config: new MachineConfig({ image: "nginx" }) }),
      ],
    );
    const body = JSON.parse(flySerializer.serialize(entities)).api.body;
    // Only fields present on flaps CreateMachineRequest / MachineConfig.
    expect(Object.keys(body).sort()).toEqual(["config", "name", "region"]);
    expect(Object.keys(body.config.guest ?? {})).toEqual([]);
  });
});
