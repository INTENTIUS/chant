import { describe, expect, it } from "vitest";
import { isCompositeInstance } from "@intentius/chant";
import { GvcEnvironment, ServerlessService, CronJob, StatefulService, SecretAccess, PublicDomain } from "./index";
import { identityLink, secretRef } from "./secret-access";
import { isApexDomain } from "./public-domain";
import { propsOf, readString, readArray, readNumber, readPath } from "../entity-props";

describe("GvcEnvironment", () => {
  it("builds location links from the org and location ids", () => {
    const { gvc } = GvcEnvironment({ name: "prod", org: "acme", locations: ["aws-us-east-1"] });

    expect(isCompositeInstance({ gvc })).toBe(false);
    expect(readString(gvc, "name")).toBe("prod");
    expect(readArray(gvc, "spec", "staticPlacement", "locationLinks")).toEqual([
      "/org/acme/location/aws-us-east-1",
    ]);
  });

  it("sorts locations and pull secrets so output is stable", () => {
    const { gvc } = GvcEnvironment({
      name: "prod",
      org: "acme",
      locations: ["gcp-us-central1", "aws-us-east-1"],
      pullSecrets: ["z-creds", "a-creds"],
    });

    expect(readArray(gvc, "spec", "staticPlacement", "locationLinks")).toEqual([
      "/org/acme/location/aws-us-east-1",
      "/org/acme/location/gcp-us-central1",
    ]);
    expect(readArray(gvc, "spec", "pullSecretLinks")).toEqual(["//secret/a-creds", "//secret/z-creds"]);
  });

  it("refuses a GVC with no locations", () => {
    expect(() => GvcEnvironment({ name: "prod", org: "acme", locations: [] })).toThrow(/runs them nowhere/);
  });

  it("refuses a location id that is not one", () => {
    expect(() => GvcEnvironment({ name: "prod", org: "acme", locations: ["us-east-1"] })).toThrow(
      /not a location id/,
    );
  });
});

describe("ServerlessService", () => {
  it("emits exactly one HTTP port", () => {
    const { workload } = ServerlessService({ name: "web", gvc: "prod", image: "nginx:1.27" });
    const containers = readArray(workload, "spec", "containers");

    expect(readString(workload, "spec", "type")).toBe("serverless");
    expect(containers).toHaveLength(1);
    const ports = readArray(containers[0], "ports");
    expect(ports).toHaveLength(1);
    expect(readNumber(ports[0], "number")).toBe(8080);
  });

  it("leaves the firewall closed by default in both directions", () => {
    const { workload } = ServerlessService({ name: "web", gvc: "prod", image: "nginx:1.27" });
    expect(readArray(workload, "spec", "firewallConfig", "external", "inboundAllowCIDR")).toEqual([]);
    expect(readArray(workload, "spec", "firewallConfig", "external", "outboundAllowCIDR")).toEqual([]);
  });

  it("maps env to Control Plane's name/value pairs", () => {
    const { workload } = ServerlessService({
      name: "web",
      gvc: "prod",
      image: "nginx:1.27",
      env: { LOG_LEVEL: "info" },
    });
    const env = readArray(readArray(workload, "spec", "containers")[0], "env");
    expect(env).toEqual([{ name: "LOG_LEVEL", value: "info" }]);
  });

  it("honours per-member defaults", () => {
    const { workload } = ServerlessService({
      name: "web",
      gvc: "prod",
      image: "nginx:1.27",
      defaults: { workload: { description: "the web tier" } },
    });
    expect(readString(workload, "description")).toBe("the web tier");
  });
});

describe("CronJob", () => {
  it("sets the schedule and exposes no ports", () => {
    const { workload } = CronJob({ name: "nightly", gvc: "prod", image: "busybox:1.36", schedule: "0 3 * * *" });

    expect(readString(workload, "spec", "type")).toBe("cron");
    expect(readString(workload, "spec", "job", "schedule")).toBe("0 3 * * *");
    expect(readArray(readArray(workload, "spec", "containers")[0], "ports")).toEqual([]);
    expect(readArray(workload, "spec", "firewallConfig", "external", "inboundAllowCIDR")).toEqual([]);
  });

  it("defaults to Forbid so runs do not overlap", () => {
    const { workload } = CronJob({ name: "nightly", gvc: "prod", image: "busybox:1.36", schedule: "0 3 * * *" });
    expect(readString(workload, "spec", "job", "concurrencyPolicy")).toBe("Forbid");
  });
});

describe("StatefulService", () => {
  it("pairs the workload and volume set on the same mount", () => {
    const { workload, volumeSet } = StatefulService({
      name: "db",
      gvc: "prod",
      image: "postgres:17",
      mountPath: "/var/lib/postgresql/data",
      capacityGb: 20,
    });

    expect(readString(volumeSet, "name")).toBe("db-data");
    expect(readString(volumeSet, "gvc")).toBe("prod");
    expect(readString(workload, "spec", "type")).toBe("stateful");

    const volumes = readArray(readArray(workload, "spec", "containers")[0], "volumes");
    expect(readString(volumes[0], "uri")).toBe("cpln://volumeset/db-data");
    expect(readString(volumes[0], "path")).toBe("/var/lib/postgresql/data");
  });

  it("refuses a capacity below the performance class floor", () => {
    expect(() =>
      StatefulService({
        name: "db",
        gvc: "prod",
        image: "postgres:17",
        mountPath: "/data",
        capacityGb: 50,
        performanceClass: "high-throughput-ssd",
      }),
    ).toThrow(/200 GB minimum/);
  });

  it("forces performanceClass shared for a shared filesystem", () => {
    // Control Plane forces it server-side; declaring it too keeps the manifest
    // equal to what comes back, so it does not read as drift on every plan.
    const { volumeSet } = StatefulService({
      name: "files",
      gvc: "prod",
      image: "nginx:1.27",
      mountPath: "/files",
      capacityGb: 10,
      fileSystemType: "shared",
    });
    expect(readString(volumeSet, "spec", "performanceClass")).toBe("shared");
  });

  it("keeps createFinalSnapshot on and defaults to ext4", () => {
    // `createFinalSnapshot` auto-snapshots before any volume deletion. It
    // defaults on upstream; declaring it means a later edit that turns it off
    // is a visible diff rather than an inherited default nobody chose.
    const { volumeSet } = StatefulService({
      name: "db",
      gvc: "prod",
      image: "postgres:17",
      mountPath: "/data",
      capacityGb: 20,
    });
    expect(readString(volumeSet, "spec", "fileSystemType")).toBe("ext4");
    expect(propsOf(readPath(volumeSet, "spec", "snapshots")).createFinalSnapshot).toBe(true);
  });
});

describe("SecretAccess", () => {
  it("emits a GVC-qualified principal link", () => {
    const { identity, policy } = SecretAccess({ name: "api", gvc: "prod", secrets: ["db-password"] });

    expect(readString(identity, "name")).toBe("api");
    expect(readString(policy, "targetKind")).toBe("secret");
    expect(readArray(policy, "targetLinks")).toEqual(["//secret/db-password"]);

    const bindings = readArray(policy, "bindings");
    expect(readArray(bindings[0], "principalLinks")).toEqual(["//gvc/prod/identity/api"]);
    // The bare form is accepted by Control Plane and silently ignored.
    expect(JSON.stringify(bindings)).not.toContain('"//identity/api"');
  });

  it("sorts and deduplicates permissions", () => {
    const { policy } = SecretAccess({
      name: "api",
      gvc: "prod",
      secrets: ["db"],
      permissions: ["reveal", "edit", "reveal"],
    });
    expect(readArray(readArray(policy, "bindings")[0], "permissions")).toEqual(["edit", "reveal"]);
  });

  it("refuses an empty secret list", () => {
    expect(() => SecretAccess({ name: "api", gvc: "prod", secrets: [] })).toThrow(/grants nothing/);
  });
});

describe("PublicDomain", () => {
  it("routes to the GVC when no routes are given", () => {
    const { domain } = PublicDomain({ name: "api.example.com", gvc: "prod" });
    expect(readString(domain, "spec", "gvcLink")).toBe("//gvc/prod");
    expect(readArray(domain, "spec", "ports")).toEqual([]);
  });

  it("emits per-port routes and no gvcLink when routes are given", () => {
    const { domain } = PublicDomain({
      name: "api.example.com",
      gvc: "prod",
      routes: [{ prefix: "/v1", workload: "api", port: 8080 }],
    });

    expect(readString(domain, "spec", "gvcLink")).toBeUndefined();
    const routes = readArray(readArray(domain, "spec", "ports")[0], "routes");
    expect(readString(routes[0], "workloadLink")).toBe("//gvc/prod/workload/api");
  });

  it("defaults the challenge type to the one the DNS mode allows", () => {
    expect(readString(PublicDomain({ name: "api.example.com", gvc: "prod" }).domain, "spec", "certChallengeType")).toBe(
      "http01",
    );
    expect(
      readString(
        PublicDomain({ name: "api.example.com", gvc: "prod", dnsMode: "ns" }).domain,
        "spec",
        "certChallengeType",
      ),
    ).toBe("dns01");
  });

  it("refuses an apex domain in ns mode", () => {
    expect(() => PublicDomain({ name: "example.com", gvc: "prod", dnsMode: "ns" })).toThrow(/apex/);
  });

  it("refuses a route with both prefix and regex", () => {
    expect(() =>
      PublicDomain({
        name: "api.example.com",
        gvc: "prod",
        routes: [{ prefix: "/v1", regex: "^/v1", workload: "api" }],
      }),
    ).toThrow(/only one may be provided/);
  });
});

describe("helpers", () => {
  it("qualifies an identity link", () => {
    expect(identityLink("prod", "api")).toBe("//gvc/prod/identity/api");
  });

  it("qualifies a secret reference with its field", () => {
    expect(secretRef("db", "payload")).toBe("cpln://secret/db.payload");
  });

  it("recognises apex domains", () => {
    expect(isApexDomain("example.com")).toBe(true);
    expect(isApexDomain("api.example.com")).toBe(false);
  });
});
