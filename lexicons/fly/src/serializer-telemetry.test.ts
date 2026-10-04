/**
 * Telemetry attribution in the fly serializer (#3060): each Machine's
 * `config.env` gets `OTEL_SERVICE_NAME` and `OTEL_RESOURCE_ATTRIBUTES` when the
 * build hands it `context.telemetry`, and nothing changes without it.
 */
import { describe, expect, it } from "vitest";
import type { Declarable } from "@intentius/chant";
import { flySerializer } from "./serializer";
import { App, Machine, MachineConfig } from "./generated/index";

const telemetry = { workspace: "acme", member: "svc", environment: "prod" };

function stack(...entries: Array<[string, unknown]>): Map<string, Declarable> {
  return new Map(entries as Array<[string, Declarable]>);
}

const site = (config: Record<string, unknown>) =>
  stack(["app", new App({ name: "notes", org_slug: "acme" })], ["web", new Machine({ name: "web", config: new MachineConfig(config) })]);

const build = (entities: Map<string, Declarable>, withTelemetry = true) =>
  JSON.parse(flySerializer.serialize(entities, undefined, withTelemetry ? { telemetry } : undefined) as string);

describe("fly telemetry attribution (#3060)", () => {
  it("stamps each Machine with the app's name and the Machine's declaration id", () => {
    const out = build(site({ image: "node:22-slim", env: { PORT: "8080" } }));
    expect(out.web.body.config.env).toEqual({
      PORT: "8080",
      OTEL_SERVICE_NAME: "notes",
      OTEL_RESOURCE_ATTRIBUTES: "chant.workspace=acme,chant.member=svc,chant.decl=web,deployment.environment.name=prod",
    });
    // The App's create body has no env.
    expect(out.app.body).toEqual({ app_name: "notes", org_slug: "acme" });
  });

  it("adds an env to a Machine that declares none", () => {
    const out = build(site({ image: "node:22-slim" }));
    expect(out.web.body.config.env.OTEL_SERVICE_NAME).toBe("notes");
  });

  it("keeps the values a Machine sets and appends the missing attributes", () => {
    const out = build(
      site({
        image: "node:22-slim",
        env: { OTEL_SERVICE_NAME: "notes-web", OTEL_RESOURCE_ATTRIBUTES: "chant.member=team-a,team=core" },
      }),
    );
    expect(out.web.body.config.env).toEqual({
      OTEL_SERVICE_NAME: "notes-web",
      OTEL_RESOURCE_ATTRIBUTES: "chant.member=team-a,team=core,chant.workspace=acme,chant.decl=web,deployment.environment.name=prod",
    });
  });

  it("gives service.version from an image pinned by digest", () => {
    const digest = "sha256:" + "a".repeat(64);
    const out = build(site({ image: `registry.fly.io/notes@${digest}` }));
    expect(out.web.body.config.env.OTEL_RESOURCE_ATTRIBUTES).toBe(
      `chant.workspace=acme,chant.member=svc,chant.decl=web,deployment.environment.name=prod,service.version=${encodeURIComponent(digest)}`,
    );
  });

  it("names the Machine's app when the stack has several, and falls back to the export name when none is resolved", () => {
    const out = build(
      stack(
        ["a", new App({ name: "alpha" })],
        ["b", new App({ name: "beta" })],
        ["worker", new Machine({ app: "beta", config: new MachineConfig({ image: "x" }) })],
        ["loose", new Machine({ config: new MachineConfig({ image: "x" }) })],
      ),
    );
    expect(out.worker.body.config.env.OTEL_SERVICE_NAME).toBe("beta");
    expect(out.loose.body.config.env.OTEL_SERVICE_NAME).toBe("loose");
  });

  it("writes the same bytes as before without context.telemetry", () => {
    const entities = site({ image: "node:22-slim", env: { PORT: "8080" } });
    const plain = flySerializer.serialize(entities) as string;
    expect(plain).not.toContain("OTEL_");
    expect(flySerializer.serialize(entities, undefined, {})).toBe(plain);
  });
});
