/**
 * The FlySite composite (#2809): the App and the Machine a release ships to,
 * with the Volume, IP and Secrets it is asked for, serialized to the flaps
 * requests the applier and the `fly-release` steps read.
 */
import { describe, expect, test } from "vitest";
import type { Declarable } from "@intentius/chant";
import { flySerializer } from "../serializer";
import { releaseTarget } from "../op/activities/machine-release";
import { FlySite } from "./fly-site";

function plan(members: Record<string, Declarable>): Record<string, { endpoint: string; body: Record<string, unknown> }> {
  return JSON.parse(flySerializer.serialize(new Map(Object.entries(members).map(([k, v]) => [`flySite_${k}`, v]))) as string);
}

describe("FlySite", () => {
  test("declares the App, the Volume, the IP, the Secret and the one Machine, mounted and behind 443 and 80", () => {
    const site = FlySite({
      app: "notes",
      org: "acme",
      region: "iad",
      image: "node:22-slim",
      env: { PORT: "8080", APP_DATA: "/data" },
      volume: { name: "data", sizeGb: 1, path: "/data" },
      ip: "shared_v4",
      secrets: { APP_SECRET: undefined },
    });
    expect(Object.keys(site.members).sort()).toEqual(["app", "appSecret", "ip", "machine", "volume"]);

    const out = plan(site.members);
    expect(out.flySite_app.body).toEqual({ app_name: "notes", org_slug: "acme" });
    expect(out.flySite_volume).toMatchObject({ endpoint: "/v1/apps/notes/volumes", body: { name: "data", region: "iad", size_gb: 1 } });
    expect(out.flySite_ip.endpoint).toBe("/v1/apps/notes/ip_assignments");
    expect(out.flySite_appSecret.endpoint).toBe("/v1/apps/notes/secrets/APP_SECRET");
    expect(out.flySite_machine).toMatchObject({
      endpoint: "/v1/apps/notes/machines",
      body: {
        name: "web",
        region: "iad",
        config: {
          image: "node:22-slim",
          guest: { cpu_kind: "shared", cpus: 1, memory_mb: 256 },
          mounts: [{ volume: "data", path: "/data" }],
          services: [{ protocol: "tcp", internal_port: 8080, ports: [{ port: 443, handlers: ["tls", "http"] }, { port: 80, handlers: ["http"] }] }],
          env: { PORT: "8080", APP_DATA: "/data" },
        },
      },
    });

    // A release finds the Machine without being told its name.
    expect(releaseTarget(out as never)).toMatchObject({ app: "notes", entity: "flySite_machine", name: "web" });
  });

  test("declares only the App and the Machine when nothing else is asked for", () => {
    const site = FlySite({ app: "bare", org: "acme", region: "ord", machine: "api", image: "nginx:1", port: 80 });
    expect(Object.keys(site.members).sort()).toEqual(["app", "machine"]);
    const out = plan(site.members);
    expect(out.flySite_machine.body).toMatchObject({ name: "api", config: { image: "nginx:1", services: [{ internal_port: 80 }] } });
    expect((out.flySite_machine.body.config as Record<string, unknown>).mounts).toBeUndefined();
  });

  test("a Secret never takes another member's name", () => {
    const site = FlySite({ app: "x", org: "acme", region: "iad", image: "i", secrets: { APP: "v", DB_URL: "u" } });
    expect(Object.keys(site.members).sort()).toEqual(["app", "appSecret", "dbUrl", "machine"]);
  });
});
