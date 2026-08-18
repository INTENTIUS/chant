import { afterEach, describe, expect, it } from "vitest";
import type { Declarable } from "@intentius/chant";
import { resolveAttrRefs } from "@intentius/chant/discovery/resolve";
import { renderSerializer, stampOwnership } from "./serializer";
import {
  WebService,
  WebServiceDetails,
  StaticSite,
  StaticSiteDetails,
  CronJob,
  CronJobDetails,
  NativeEnvironmentDetails,
  DockerDetails,
  Postgres,
  KeyValue,
  EnvGroup,
  Project,
  ProjectEnvironment,
  Environment,
  Disk,
  CustomDomain,
  Image,
} from "./generated/index";
import { Render } from "./pseudo";
import { RENDER_ENV_OWNERSHIP_KEYS } from "./ownership";

/** Author a map of declarables keyed by logical name, in insertion order. */
function stack(...entries: Array<[string, unknown]>): Map<string, Declarable> {
  return new Map(entries as Array<[string, Declarable]>);
}

const parse = (entities: Map<string, Declarable>, ctx?: Parameters<typeof renderSerializer.serialize>[2]) => {
  // The build pipeline assigns each entity's logical name before serializing;
  // do the same so attribute reads (`db.internalConnectionString`) resolve.
  resolveAttrRefs(entities);
  return JSON.parse(renderSerializer.serialize(entities, undefined, ctx));
};

describe("render serializer", () => {
  afterEach(() => {
    delete process.env.RENDER_OWNER_ID;
    delete process.env.RENDER_REGION;
  });

  it("serializes an empty map to valid JSON", () => {
    expect(JSON.parse(renderSerializer.serialize(new Map()))).toEqual({});
  });

  it("has the correct name and rule prefix", () => {
    expect(renderSerializer.name).toBe("render");
    expect(renderSerializer.rulePrefix).toBe("REN");
  });

  it("emits a WebService as POST /services with the fixed type, the marker, and the owner", () => {
    process.env.RENDER_OWNER_ID = "tea-123";
    const out = parse(
      stack([
        "web",
        new WebService({
          name: "my-web",
          repo: "https://github.com/render-examples/express-hello-world",
          serviceDetails: new WebServiceDetails({
            runtime: "node",
            plan: "starter",
            region: "oregon",
            envSpecificDetails: new NativeEnvironmentDetails({ buildCommand: "npm ci", startCommand: "npm start" }),
          }),
          envVars: [{ key: "LOG_LEVEL", value: "info" }],
        }),
      ]),
    );
    expect(out.web.kind).toBe("WebService");
    expect(out.web.entityType).toBe("Render::Services::WebService");
    expect(out.web.endpoint).toBe("/services");
    expect(out.web.method).toBe("POST");
    expect(out.web.name).toBe("my-web");
    expect(out.web.body.type).toBe("web_service");
    expect(out.web.body.ownerId).toBe("tea-123");
    expect(out.web.body.serviceDetails).toEqual({
      runtime: "node",
      plan: "starter",
      region: "oregon",
      envSpecificDetails: { buildCommand: "npm ci", startCommand: "npm start" },
    });
    expect(out.web.body.envVars).toEqual([
      { key: "LOG_LEVEL", value: "info" },
      { key: RENDER_ENV_OWNERSHIP_KEYS.managedBy, value: "chant" },
    ]);
  });

  it("stamps stack/env identity from the serialize context", () => {
    const out = parse(
      stack(["web", new WebService({ name: "w", serviceDetails: new WebServiceDetails({ runtime: "docker" }) })]),
      { ownership: { stack: "shop", env: "prod" } },
    );
    expect(out.web.body.envVars).toEqual([
      { key: "CHANT_MANAGED_BY", value: "chant" },
      { key: "CHANT_STACK", value: "shop" },
      { key: "CHANT_ENV", value: "prod" },
    ]);
  });

  it("the marker wins over a colliding user env var", () => {
    expect(
      stampOwnership([{ key: "CHANT_MANAGED_BY", value: "me" }, { key: "A", value: "1" }], { CHANT_MANAGED_BY: "chant" }),
    ).toEqual([
      { key: "A", value: "1" },
      { key: "CHANT_MANAGED_BY", value: "chant" },
    ]);
  });

  it("leaves an $owner marker when no owner is known, and resolves Render.OwnerId from the env", () => {
    const noEnv = parse(stack(["db", new Postgres({ name: "db", plan: "free", version: "16" })]));
    expect(noEnv.db.body.ownerId).toEqual({ $owner: true });

    process.env.RENDER_OWNER_ID = "tea-999";
    const explicit = parse(stack(["db", new Postgres({ name: "db", plan: "free", version: "16", ownerId: Render.OwnerId })]));
    expect(explicit.db.body.ownerId).toBe("tea-999");
    expect(explicit.db.endpoint).toBe("/postgres");
    expect(explicit.db.kind).toBe("Postgres");
  });

  it("resolves Render.Region from RENDER_REGION with an oregon fallback", () => {
    const fallback = parse(stack(["kv", new KeyValue({ name: "kv", plan: "free", region: Render.Region })]));
    expect(fallback.kv.body.region).toBe("oregon");
    process.env.RENDER_REGION = "frankfurt";
    const set = parse(stack(["kv", new KeyValue({ name: "kv", plan: "free", region: Render.Region })]));
    expect(set.kv.body.region).toBe("frankfurt");
  });

  it("falls back to the entity name when no explicit name", () => {
    const out = parse(stack(["billing", new Project({ name: "billing", environments: [new ProjectEnvironment({ name: "prod" })] })]));
    expect(out.billing.name).toBe("billing");
    expect(out.billing.body.environments).toEqual([{ name: "prod" }]);
  });

  it("turns a declared-resource reference into a $ref marker and an attribute read into $attr", () => {
    const db = new Postgres({ name: "db", plan: "free", version: "16" });
    const project = new Project({ name: "p", environments: [] });
    const env = new Environment({ name: "prod", projectId: project });
    const web = new WebService({
      name: "web",
      environmentId: env,
      serviceDetails: new WebServiceDetails({ runtime: "docker" }),
      envVars: [{ key: "DATABASE_URL", value: db.internalConnectionString }],
    });
    const out = parse(stack(["db", db], ["project", project], ["env", env], ["web", web]));
    expect(out.env.body.projectId).toEqual({ $ref: "project" });
    expect(out.web.body.environmentId).toEqual({ $ref: "env" });
    expect(out.web.body.envVars[0]).toEqual({
      key: "DATABASE_URL",
      value: { $attr: { entity: "db", attribute: "internalConnectionString" } },
    });
  });

  it("routes child collections through pathParams and fills literal ids into the endpoint", () => {
    const web = new WebService({ name: "web", serviceDetails: new WebServiceDetails({ runtime: "docker" }) });
    const out = parse(
      stack(
        ["web", web],
        ["domain", new CustomDomain({ name: "example.com", serviceId: web })],
        ["literal", new CustomDomain({ name: "www.example.com", serviceId: "srv-abc" })],
        ["disk", new Disk({ name: "data", sizeGB: 10, mountPath: "/data", serviceId: web })],
      ),
    );
    expect(out.domain.endpoint).toBe("/services/{serviceId}/custom-domains");
    expect(out.domain.pathParams).toEqual({ serviceId: { $ref: "web" } });
    expect(out.domain.body).toEqual({ name: "example.com" });
    expect(out.literal.endpoint).toBe("/services/srv-abc/custom-domains");
    // Disk's serviceId is a body field, not a path segment.
    expect(out.disk.endpoint).toBe("/disks");
    expect(out.disk.body.serviceId).toEqual({ $ref: "web" });
    expect(out.disk.pathParams).toBeUndefined();
  });

  it("defaults image.ownerId to the service ownerId", () => {
    process.env.RENDER_OWNER_ID = "tea-1";
    const out = parse(
      stack([
        "web",
        new WebService({
          name: "web",
          image: new Image({ imagePath: "docker.io/library/nginx:latest" }),
          serviceDetails: new WebServiceDetails({ runtime: "image" }),
        }),
      ]),
    );
    expect(out.web.body.image).toEqual({ imagePath: "docker.io/library/nginx:latest", ownerId: "tea-1" });
  });

  it("emits every service type with its discriminator", () => {
    const out = parse(
      stack(
        ["site", new StaticSite({ name: "site", serviceDetails: new StaticSiteDetails({ publishPath: "dist" }) })],
        [
          "cron",
          new CronJob({
            name: "cron",
            serviceDetails: new CronJobDetails({
              runtime: "docker",
              schedule: "0 * * * *",
              envSpecificDetails: new DockerDetails({ dockerfilePath: "./Dockerfile" }),
            }),
          }),
        ],
      ),
    );
    expect(out.site.body.type).toBe("static_site");
    expect(out.cron.body.type).toBe("cron_job");
    expect(out.cron.body.serviceDetails.schedule).toBe("0 * * * *");
  });

  it("stamps env groups too, and keeps their env vars", () => {
    const out = parse(stack(["shared", new EnvGroup({ name: "shared", envVars: [{ key: "A", value: "1" }] })]));
    expect(out.shared.endpoint).toBe("/env-groups");
    expect(out.shared.body.envVars).toEqual([
      { key: "A", value: "1" },
      { key: "CHANT_MANAGED_BY", value: "chant" },
    ]);
  });
});
