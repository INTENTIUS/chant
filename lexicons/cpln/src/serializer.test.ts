import { describe, expect, it } from "vitest";
import type { Declarable } from "@intentius/chant/declarable";
import { cplnSerializer, cplnLink } from "./serializer";
import { Gvc, Workload, Identity, Secret, Policy, VolumeSet } from "./generated/index";
import { kindByName } from "./kinds";

/** Build the entity map the serializer is handed. */
function entities(pairs: Array<[string, unknown]>): Map<string, Declarable> {
  return new Map(pairs as Array<[string, Declarable]>);
}

/** Split the emitted multi-document YAML into documents. */
function documents(yaml: string): string[] {
  return yaml
    .split(/^---$/m)
    .map((doc) => doc.trim())
    .filter(Boolean);
}

describe("cpln serializer", () => {
  it("has the correct name and rule prefix", () => {
    expect(cplnSerializer.name).toBe("cpln");
    expect(cplnSerializer.rulePrefix).toBe("CPL");
  });

  it("serializes an empty map to an empty string", () => {
    expect(cplnSerializer.serialize(new Map())).toBe("");
  });

  it("emits kind and name first", () => {
    const gvc = new Gvc({ name: "prod", spec: { staticPlacement: { locationLinks: ["//location/aws-us-east-1"] } } });
    const output = cplnSerializer.serialize(entities([["gvc", gvc]]));

    expect(output.startsWith("kind: gvc\nname: prod\n")).toBe(true);
  });

  it("emits the gvc key for a GVC-scoped kind", () => {
    const workload = new Workload({ name: "web", gvc: "prod", spec: { type: "serverless" } });
    const output = cplnSerializer.serialize(entities([["web", workload]]));

    expect(output).toContain("kind: workload");
    expect(output).toContain("gvc: prod");
  });

  it("falls back to the entity name when no name is declared", () => {
    const secret = new Secret({ type: "opaque" } as never);
    const output = cplnSerializer.serialize(entities([["fallback-name", secret]]));

    expect(output).toContain("name: fallback-name");
    expect(output).not.toContain("undefined");
  });

  it("never emits server-side fields", () => {
    // Control Plane's own guidance: `status`, `id`, `created`, `lastModified`
    // and `links` break `cpln apply`. They are attributes here, so they cannot
    // reach a document — this asserts that stays true.
    const workload = new Workload({ name: "web", gvc: "prod", spec: { type: "serverless" } });
    const output = cplnSerializer.serialize(entities([["web", workload]]));

    for (const field of ["status:", "id:", "created:", "lastModified:", "links:", "version:"]) {
      expect(output, `${field} reached the manifest`).not.toContain(field);
    }
  });

  it("orders documents dependency-first and sorts within a kind", () => {
    const gvc = new Gvc({ name: "prod" });
    const secret = new Secret({ name: "db", type: "opaque" });
    const beta = new Workload({ name: "beta", gvc: "prod", spec: { type: "serverless" } });
    const alpha = new Workload({ name: "alpha", gvc: "prod", spec: { type: "serverless" } });

    const output = cplnSerializer.serialize(
      entities([
        ["beta", beta],
        ["gvc", gvc],
        ["alpha", alpha],
        ["secret", secret],
      ]),
    );

    const kinds = documents(output).map((doc) => doc.split("\n")[0]);
    expect(kinds).toEqual(["kind: gvc", "kind: secret", "kind: workload", "kind: workload"]);

    const workloadNames = documents(output)
      .filter((doc) => doc.startsWith("kind: workload"))
      .map((doc) => doc.split("\n")[1]);
    expect(workloadNames).toEqual(["name: alpha", "name: beta"]);
  });

  it("resolves a resource reference to its Control Plane link", () => {
    const identity = new Identity({ name: "api-identity", gvc: "prod" });
    const workload = new Workload({
      name: "api",
      gvc: "prod",
      spec: { type: "serverless", identityLink: identity as never },
    });

    const output = cplnSerializer.serialize(
      entities([
        ["identity", identity],
        ["api", workload],
      ]),
    );

    // The GVC-qualified form specifically: the bare //identity/NAME is
    // silently ignored by Control Plane.
    expect(output).toContain("identityLink: //gvc/prod/identity/api-identity");
    expect(output).not.toContain("identityLink: //identity/");
  });

  it("uses the declared name, not the entity name, when building a link", () => {
    const secret = new Secret({ name: "db-password", type: "opaque" });
    const policy = new Policy({
      name: "grants",
      targetKind: "secret",
      targetLinks: [secret as never],
    });

    const output = cplnSerializer.serialize(
      entities([
        ["secretEntity", secret],
        ["grants", policy],
      ]),
    );

    expect(output).toContain("//secret/db-password");
  });

  it("stamps the ownership marker even when no tags are declared", () => {
    const gvc = new Gvc({ name: "prod" });
    const output = cplnSerializer.serialize(entities([["gvc", gvc]]), undefined, {
      ownership: { stack: "demo", env: "prod" },
    });

    expect(output).toContain("chant.intentius.io/managed-by: chant");
    expect(output).toContain("chant.intentius.io/stack: demo");
    expect(output).toContain("chant.intentius.io/env: prod");
  });

  it("merges the ownership marker with declared tags", () => {
    const gvc = new Gvc({ name: "prod", tags: { team: "platform" } });
    const output = cplnSerializer.serialize(entities([["gvc", gvc]]), undefined, {
      ownership: { stack: "demo" },
    });

    expect(output).toContain("team: platform");
    expect(output).toContain("chant.intentius.io/managed-by: chant");
    // No env in the marker means no env key, not an empty one.
    expect(output).not.toContain("chant.intentius.io/env");
  });

  it("emits no tags block when there is nothing to stamp", () => {
    const gvc = new Gvc({ name: "prod" });
    expect(cplnSerializer.serialize(entities([["gvc", gvc]]))).not.toContain("tags:");
  });

  it("ignores entities from other lexicons", () => {
    const foreign = { entityType: "K8s::Apps::Deployment", props: { name: "x" } };
    const gvc = new Gvc({ name: "prod" });
    const output = cplnSerializer.serialize(
      entities([
        ["foreign", foreign],
        ["gvc", gvc],
      ]),
    );

    expect(documents(output)).toHaveLength(1);
  });

  it("refuses to serialize an attribute reference", () => {
    const gvc = new Gvc({ name: "prod" });
    // The build pipeline assigns logical names before serializing; doing it
    // here is what routes the walker into the visitor's `attrRef` rather than
    // failing earlier on an unnamed ref.
    (gvc.id as unknown as { _setLogicalName(name: string): void })._setLogicalName("gvc");

    const workload = new Workload({
      name: "web",
      gvc: "prod",
      spec: { type: "serverless", identityLink: gvc.id as never },
    });

    expect(() =>
      cplnSerializer.serialize(
        entities([
          ["gvc", gvc],
          ["web", workload],
        ]),
      ),
    ).toThrow(/no.*template-time reference language/i);
  });

  it("serializes a volume set mount alongside its workload", () => {
    const volumeSet = new VolumeSet({
      name: "data",
      gvc: "prod",
      spec: { initialCapacity: 20, fileSystemType: "ext4", performanceClass: "general-purpose-ssd" },
    });
    const workload = new Workload({
      name: "db",
      gvc: "prod",
      spec: {
        type: "stateful",
        containers: [
          { name: "main", image: "postgres:17", volumes: [{ uri: "cpln://volumeset/data", path: "/data" }] },
        ],
      },
    });

    const output = cplnSerializer.serialize(
      entities([
        ["db", workload],
        ["data", volumeSet],
      ]),
    );

    const kinds = documents(output).map((doc) => doc.split("\n")[0]);
    expect(kinds).toEqual(["kind: volumeset", "kind: workload"]);
    expect(output).toContain("uri: cpln://volumeset/data");
  });
});

describe("cplnLink", () => {
  it("builds each kind's link form", () => {
    expect(cplnLink(kindByName("gvc")!, "prod")).toBe("//gvc/prod");
    expect(cplnLink(kindByName("secret")!, "db")).toBe("//secret/db");
    expect(cplnLink(kindByName("workload")!, "web", "prod")).toBe("//gvc/prod/workload/web");
    expect(cplnLink(kindByName("identity")!, "api", "prod")).toBe("//gvc/prod/identity/api");
  });

  it("refuses a GVC-scoped link with no resolvable GVC", () => {
    expect(() => cplnLink(kindByName("identity")!, "api")).toThrow(/silently ignored/);
  });
});
