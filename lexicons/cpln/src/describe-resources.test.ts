import { describe, expect, it } from "vitest";
import { normalizeObservation } from "@intentius/chant/observation";
import { describeResources, gvcOf, referenceAttributes } from "./describe-resources";
import { authorization, type CplnHttp, type CplnResource } from "./api";
import { kindByName } from "./kinds";
import { CPLN_TAG_OWNERSHIP_KEYS } from "./ownership";

const OWNED = { [CPLN_TAG_OWNERSHIP_KEYS.managedBy]: "chant", [CPLN_TAG_OWNERSHIP_KEYS.stack]: "demo" };

/** A stub transport backed by a path → body map. Records what was requested. */
function stubHttp(routes: Record<string, unknown>): CplnHttp & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async get(path: string) {
      calls.push(path);
      return routes[path];
    },
  };
}

const config = { endpoint: "https://api.cpln.io", org: "acme", token: "sa-key" };

function declared(entries: Array<[string, string, Record<string, unknown>]>) {
  return {
    environment: "prod",
    buildOutput: "",
    entityNames: entries.map(([name]) => name),
    entities: new Map(entries.map(([name, entityType, props]) => [name, { entityType, props }])),
  };
}

describe("describeResources", () => {
  it("reports a live resource as present and owned", async () => {
    const http = stubHttp({
      "/org/acme/gvc": { items: [{ id: "abc", name: "prod", tags: OWNED, lastModified: "2026-01-01T00:00:00Z" }] },
    });

    const result = await describeResources({
      ...declared([["gvc", "Cpln::Core::Gvc", { name: "prod" }]]),
      config,
      http,
    });

    const { resources, unobserved } = normalizeObservation(result);
    expect(unobserved).toEqual({});
    expect(resources.gvc.type).toBe("Cpln::Core::Gvc");
    expect(resources.gvc.physicalId).toBe("abc");
    expect(resources.gvc.ownership).toBe("owned");
    expect(resources.gvc.lastUpdated).toBe("2026-01-01T00:00:00Z");
  });

  it("reports an unmarked resource as foreign, not owned", async () => {
    const http = stubHttp({ "/org/acme/gvc": { items: [{ name: "prod" }] } });
    const result = await describeResources({
      ...declared([["gvc", "Cpln::Core::Gvc", { name: "prod" }]]),
      config,
      http,
    });

    expect(normalizeObservation(result).resources.gvc.ownership).toBe("foreign");
  });

  it("filters a foreign resource to a typed NOT-OBSERVED under `owned`", async () => {
    // Not absent — absence would classify as a create, which is exactly the
    // wrong answer for something that exists and belongs to someone else.
    const http = stubHttp({ "/org/acme/gvc": { items: [{ name: "prod" }] } });
    const result = await describeResources({
      ...declared([["gvc", "Cpln::Core::Gvc", { name: "prod" }]]),
      owned: true,
      config,
      http,
    });

    const { resources, unobserved } = normalizeObservation(result);
    expect(resources).toEqual({});
    expect(unobserved.gvc.reason).toBe("filtered");
    expect(unobserved.gvc.detail).toContain(CPLN_TAG_OWNERSHIP_KEYS.managedBy);
  });

  it("reports a missing resource as absent", async () => {
    const http = stubHttp({ "/org/acme/gvc": { items: [] } });
    const result = await describeResources({
      ...declared([["gvc", "Cpln::Core::Gvc", { name: "prod" }]]),
      config,
      http,
    });

    const { resources, unobserved } = normalizeObservation(result);
    expect(resources).toEqual({});
    expect(unobserved).toEqual({});
  });

  it("lists each kind once no matter how many entities of it are declared", async () => {
    const http = stubHttp({
      "/org/acme/workload": {
        items: [
          { name: "a", links: [{ rel: "gvc", href: "/org/acme/gvc/prod" }] },
          { name: "b", links: [{ rel: "gvc", href: "/org/acme/gvc/prod" }] },
          { name: "c", links: [{ rel: "gvc", href: "/org/acme/gvc/prod" }] },
        ],
      },
    });

    await describeResources({
      ...declared([
        ["a", "Cpln::Core::Workload", { name: "a", gvc: "prod" }],
        ["b", "Cpln::Core::Workload", { name: "b", gvc: "prod" }],
        ["c", "Cpln::Core::Workload", { name: "c", gvc: "prod" }],
      ]),
      config,
      http,
    });

    expect(http.calls).toEqual(["/org/acme/workload"]);
  });

  it("does not match a same-named resource in another GVC", async () => {
    // The org-wide rollup is what makes one request per kind possible, and it
    // is also what makes this collision reachable.
    const http = stubHttp({
      "/org/acme/workload": { items: [{ name: "web", links: [{ rel: "gvc", href: "/org/acme/gvc/staging" }] }] },
    });

    const result = await describeResources({
      ...declared([["web", "Cpln::Core::Workload", { name: "web", gvc: "prod" }]]),
      config,
      http,
    });

    expect(normalizeObservation(result).resources).toEqual({});
  });

  it("reports missing credentials as no-credentials, not read-failed", async () => {
    const result = await describeResources({
      ...declared([["gvc", "Cpln::Core::Gvc", { name: "prod" }]]),
      config: { org: "", token: "" },
      http: stubHttp({}),
    });

    expect(normalizeObservation(result).unobserved.gvc.reason).toBe("no-credentials");
  });

  it("degrades a read failure to read-failed rather than a silent absence", async () => {
    const http: CplnHttp = {
      async get() {
        throw new Error("502 Bad Gateway");
      },
    };

    const result = await describeResources({
      ...declared([["gvc", "Cpln::Core::Gvc", { name: "prod" }]]),
      config,
      http,
    });

    const { unobserved } = normalizeObservation(result);
    expect(unobserved.gvc.reason).toBe("read-failed");
    expect(unobserved.gvc.detail).toContain("502");
  });

  it("marks an unmodelled entity type unsupported-kind", async () => {
    const result = await describeResources({
      ...declared([["x", "Cpln::Core::Group", { name: "x" }]]),
      config,
      http: stubHttp({}),
    });

    expect(normalizeObservation(result).unobserved.x.reason).toBe("unsupported-kind");
  });
});

describe("gvcOf", () => {
  it("reads the GVC from the links relation", () => {
    expect(gvcOf({ links: [{ rel: "gvc", href: "/org/acme/gvc/prod" }] })).toBe("prod");
  });

  it("falls back to a string gvc field", () => {
    expect(gvcOf({ gvc: "prod" } as CplnResource)).toBe("prod");
  });

  it("falls back to an object gvc field", () => {
    expect(gvcOf({ gvc: { name: "prod" } } as CplnResource)).toBe("prod");
  });

  it("returns undefined when there is nothing to read", () => {
    expect(gvcOf({})).toBeUndefined();
  });
});

describe("referenceAttributes", () => {
  it("resolves links down to the names the graph matches on", () => {
    const refs = referenceAttributes(kindByName("workload")!, {
      name: "web",
      links: [{ rel: "gvc", href: "/org/acme/gvc/prod" }],
      spec: {
        identityLink: "//gvc/prod/identity/api",
        containers: [{ name: "m", volumes: [{ uri: "cpln://volumeset/data", path: "/data" }] }],
      },
    });

    expect(refs.gvc).toBe("prod");
    expect(refs.identity).toBe("api");
    expect(refs.volumeSets).toEqual(["data"]);
  });

  it("collects a domain's route targets", () => {
    const refs = referenceAttributes(kindByName("domain")!, {
      name: "api.example.com",
      spec: {
        ports: [
          {
            number: 443,
            routes: [
              { prefix: "/a", workloadLink: "//gvc/prod/workload/a" },
              { prefix: "/b", workloadLink: "//gvc/prod/workload/b" },
            ],
          },
        ],
      },
    });

    expect(refs.workloads).toEqual(["a", "b"]);
  });

  it("resolves a GVC's pull secrets", () => {
    const refs = referenceAttributes(kindByName("gvc")!, {
      name: "prod",
      spec: { pullSecretLinks: ["//secret/a", "//secret/b"] },
    });

    expect(refs.pullSecrets).toEqual(["a", "b"]);
  });

  it("omits relations that are absent rather than emitting empties", () => {
    expect(referenceAttributes(kindByName("secret")!, { name: "db" })).toEqual({});
  });
});

describe("authorization", () => {
  it("sends a service account key bare", () => {
    expect(authorization("abc123")).toBe("abc123");
  });

  it("sends a JWT as a bearer token", () => {
    expect(authorization("eyJhbGciOi.payload.sig")).toBe("Bearer eyJhbGciOi.payload.sig");
  });

  it("passes an already-prefixed value through", () => {
    expect(authorization("Bearer abc")).toBe("Bearer abc");
  });
});
