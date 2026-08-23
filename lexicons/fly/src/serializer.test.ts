import { afterEach, describe, expect, it } from "vitest";
import type { Declarable } from "@intentius/chant";
import { flySerializer } from "./serializer";
import { App, Machine, MachineConfig, MachineGuest, Volume, IPAddress, Certificate, Secret } from "./generated/index";
import { Fly } from "./pseudo";

/** Author a map of declarables keyed by logical name, in insertion order. */
function stack(...entries: Array<[string, unknown]>): Map<string, Declarable> {
  return new Map(entries as Array<[string, Declarable]>);
}

describe("fly serializer", () => {
  it("serializes an empty map to valid JSON", () => {
    const result = flySerializer.serialize(new Map()) as string;
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

    const out = JSON.parse(flySerializer.serialize(entities) as string);
    expect(out.web).toEqual({
      endpoint: "/v1/apps",
      method: "POST",
      body: { app_name: "my-app", org_slug: "acme" },
    });
  });

  it("falls back to the entity name for app_name when no explicit name", () => {
    const out = JSON.parse(flySerializer.serialize(stack(["billing", new App({ org_slug: "acme" })])) as string);
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

    const out = JSON.parse(flySerializer.serialize(entities) as string);
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

    const out = JSON.parse(flySerializer.serialize(entities) as string);
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
      flySerializer.serialize(entities, undefined, { ownership: { stack: "billing", env: "prod" } }) as string,
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
    const body = JSON.parse(flySerializer.serialize(entities) as string).api.body;
    // Only fields present on flaps CreateMachineRequest / MachineConfig.
    expect(Object.keys(body).sort()).toEqual(["config", "name", "region"]);
    expect(Object.keys(body.config.guest ?? {})).toEqual([]);
  });

  // ── #741 app-scoped, metadata-less resources ────────────────────────────────

  it("emits the Volume create body (CreateVolumeRequest: name/region/size_gb/encrypted) under the app", () => {
    const entities = stack(
      ["app", new App({ name: "my-app" })],
      ["data", new Volume({ name: "data", region: "iad", size_gb: 10, encrypted: true })],
    );
    const out = JSON.parse(flySerializer.serialize(entities) as string);
    expect(out.data).toEqual({
      endpoint: "/v1/apps/my-app/volumes",
      method: "POST",
      body: { name: "data", region: "iad", size_gb: 10, encrypted: true },
    });
    // No ownership marker — metadata-less type owned at the app boundary (D2).
    expect(out.data.body.metadata).toBeUndefined();
  });

  it("emits the IPAddress assign body (assignIPRequest: type/org_slug/...) under the app", () => {
    const entities = stack(
      ["app", new App({ name: "my-app" })],
      ["ip", new IPAddress({ type: "shared_v4", region: "iad", org_slug: "acme", service_name: "web", network: "default" })],
    );
    const out = JSON.parse(flySerializer.serialize(entities) as string);
    expect(out.ip).toEqual({
      endpoint: "/v1/apps/my-app/ip_assignments",
      method: "POST",
      body: { type: "shared_v4", region: "iad", org_slug: "acme", service_name: "web", network: "default" },
    });
  });

  it("emits the Certificate create body (createCertificateRequest: hostname) under the app", () => {
    const entities = stack(
      ["app", new App({ name: "my-app" })],
      ["cert", new Certificate({ hostname: "example.com" })],
    );
    const out = JSON.parse(flySerializer.serialize(entities) as string);
    expect(out.cert).toEqual({
      endpoint: "/v1/apps/my-app/certificates",
      method: "POST",
      body: { hostname: "example.com" },
    });
  });

  it("emits the Secret set body (SetAppSecretRequest: value) and flags it apply-only (D7)", () => {
    const entities = stack(
      ["app", new App({ name: "my-app" })],
      ["db-password", new Secret({ value: "s3cret" })],
    );
    const out = JSON.parse(flySerializer.serialize(entities) as string);
    expect(out["db-password"]).toEqual({
      endpoint: "/v1/apps/my-app/secrets/db-password",
      method: "POST",
      body: { value: "s3cret" },
      applyOnly: true,
    });
  });
});

// ── Pseudo-parameters (Fly.Region / Fly.OrgSlug) ────────────────────────────
describe("fly serializer pseudo-parameters", () => {
  const saved = {
    FLY_REGION: process.env.FLY_REGION,
    FLY_ORG: process.env.FLY_ORG,
    FLY_ORG_SLUG: process.env.FLY_ORG_SLUG,
  };

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("resolves Fly.Region from FLY_REGION in the serialized body", () => {
    process.env.FLY_REGION = "lhr";
    const entities = stack(
      ["app", new App({ name: "my-app" })],
      ["web", new Machine({ region: Fly.Region, config: new MachineConfig({ image: "nginx" }) })],
    );
    const body = JSON.parse(flySerializer.serialize(entities) as string).web.body;
    expect(body.region).toBe("lhr");
  });

  it("falls back to iad when FLY_REGION is unset", () => {
    delete process.env.FLY_REGION;
    const entities = stack(
      ["app", new App({ name: "my-app" })],
      ["web", new Machine({ region: Fly.Region, config: new MachineConfig({ image: "nginx" }) })],
    );
    const body = JSON.parse(flySerializer.serialize(entities) as string).web.body;
    expect(body.region).toBe("iad");
  });

  it("resolves Fly.OrgSlug from FLY_ORG (preferred over FLY_ORG_SLUG)", () => {
    process.env.FLY_ORG = "acme";
    process.env.FLY_ORG_SLUG = "ignored";
    const out = JSON.parse(flySerializer.serialize(stack(["app", new App({ name: "my-app", org_slug: Fly.OrgSlug })])) as string);
    expect(out.app.body.org_slug).toBe("acme");
  });

  it("resolves Fly.OrgSlug from FLY_ORG_SLUG when FLY_ORG is unset", () => {
    delete process.env.FLY_ORG;
    process.env.FLY_ORG_SLUG = "beta-org";
    const out = JSON.parse(flySerializer.serialize(stack(["app", new App({ name: "my-app", org_slug: Fly.OrgSlug })])) as string);
    expect(out.app.body.org_slug).toBe("beta-org");
  });

  it("falls back to personal for Fly.OrgSlug when no org env var is set", () => {
    delete process.env.FLY_ORG;
    delete process.env.FLY_ORG_SLUG;
    const out = JSON.parse(flySerializer.serialize(stack(["app", new App({ name: "my-app", org_slug: Fly.OrgSlug })])) as string);
    expect(out.app.body.org_slug).toBe("personal");
  });
});
