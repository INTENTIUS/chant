import { describe, expect, it } from "vitest";
import { load } from "js-yaml";
import { k3sSerializer } from "./serializer";
import { Agent, Mirror, Registries, RegistryAuth, RegistryConfig, RegistryTLS, Server } from "./generated/index";
import type { Declarable } from "@intentius/chant/declarable";
import type { SerializerResult } from "@intentius/chant/serializer";

function serializeOne(entities: Record<string, Declarable>): {
  text: string;
  doc: Record<string, unknown>;
} {
  const result = k3sSerializer.serialize(new Map(Object.entries(entities)));
  const text = typeof result === "string" ? result : result.primary;
  return { text, doc: load(text) as Record<string, unknown> };
}

describe("k3s serializer", () => {
  it("has the k3s name and K3S rule prefix", () => {
    expect(k3sSerializer.name).toBe("k3s");
    expect(k3sSerializer.rulePrefix).toBe("K3S");
  });

  it("serializes an empty map to an empty string", () => {
    expect(k3sSerializer.serialize(new Map())).toBe("");
  });

  it("emits a server config k3s consumes verbatim — flag names as keys", () => {
    const { doc } = serializeOne({
      server: new Server({
        "cluster-init": true,
        "tls-san": ["10.0.0.10", "cp.example.com"],
        "disable": ["traefik"],
        "write-kubeconfig-mode": "0644",
      }),
    });
    expect(doc["cluster-init"]).toBe(true);
    expect(doc["tls-san"]).toEqual(["10.0.0.10", "cp.example.com"]);
    expect(doc.disable).toEqual(["traefik"]);
    expect(doc["write-kubeconfig-mode"]).toBe("0644");
  });

  it("leads with the identity-and-join block, then alphabetical", () => {
    const { text } = serializeOne({
      agent: new Agent({
        "node-label": ["tier=edge"],
        server: "https://cp.example.com:6443",
        "token-file": "/etc/rancher/k3s/token",
        "data-dir": "/var/lib/rancher/k3s",
      }),
    });
    const keys = text
      .split("\n")
      .filter((l) => /^[a-z]/.test(l))
      .map((l) => l.split(":")[0]);
    expect(keys).toEqual(["server", "token-file", "data-dir", "node-label"]);
  });

  it("keeps booleans and zero — 0 is a value, not an absence", () => {
    const { doc } = serializeOne({
      server: new Server({ "disable-agent": false, "lb-server-port": 0 }),
    });
    expect(doc["disable-agent"]).toBe(false);
    expect(doc["lb-server-port"]).toBe(0);
  });

  it("accepts a single string where the flag takes a list", () => {
    const { doc } = serializeOne({
      server: new Server({ "tls-san": "cp.example.com" }),
    });
    expect(doc["tls-san"]).toBe("cp.example.com");
  });

  it("emits one document per config: first primary, the rest in files", () => {
    const result = k3sSerializer.serialize(
      new Map<string, Declarable>([
        ["cp", new Server({ "cluster-init": true })],
        ["worker", new Agent({ server: "https://cp:6443" })],
      ]),
    ) as SerializerResult;
    expect(typeof result).toBe("object");
    expect(result.primary).toContain("cluster-init: true");
    expect(Object.keys(result.files ?? {})).toEqual(["worker.config.yaml"]);
    expect(result.files?.["worker.config.yaml"]).toContain("server:");
  });

  it("emits registries.yaml beside a config, and as primary when alone", () => {
    const registries = new Registries({
      mirrors: { "docker.io": new Mirror({ endpoint: ["https://mirror.example.com"] }) },
    });
    const beside = k3sSerializer.serialize(
      new Map<string, Declarable>([
        ["cp", new Server({ "cluster-init": true })],
        ["registries", registries],
      ]),
    ) as SerializerResult;
    expect(Object.keys(beside.files ?? {})).toEqual(["registries.yaml"]);
    const regDoc = load(beside.files!["registries.yaml"]) as Record<string, unknown>;
    expect((regDoc.mirrors as Record<string, unknown>)["docker.io"]).toEqual({
      endpoint: ["https://mirror.example.com"],
    });

    const { doc } = serializeOne({ registries });
    expect(doc.mirrors).toBeDefined();
  });

  it("walks nested property entities into plain maps", () => {
    const { doc } = serializeOne({
      registries: new Registries({
        configs: {
          "registry.example.com": new RegistryConfig({
            auth: new RegistryAuth({ username: "puller" }),
            tls: new RegistryTLS({ ca_file: "/etc/ssl/registry-ca.pem" }),
          }),
        },
      }),
    });
    const config = (doc.configs as Record<string, Record<string, unknown>>)["registry.example.com"];
    expect(config.auth).toEqual({ username: "puller" });
    expect(config.tls).toEqual({ ca_file: "/etc/ssl/registry-ca.pem" });
  });

  it("skips property entities as standalone documents", () => {
    const result = k3sSerializer.serialize(
      new Map<string, Declarable>([
        ["cp", new Server({ "cluster-init": true })],
        ["stray", new RegistryAuth({ username: "puller" }) as unknown as Declarable],
      ]),
    );
    const text = typeof result === "string" ? result : (result as SerializerResult).primary;
    expect(text).not.toContain("username");
  });

  it("stamps ownership into node-label when the build carries a marker", () => {
    const result = k3sSerializer.serialize(
      new Map<string, Declarable>([["cp", new Server({ "cluster-init": true })]]),
      undefined,
      { ownership: { stack: "fountain", env: "local" } },
    );
    const text = typeof result === "string" ? result : (result as SerializerResult).primary;
    const doc = load(text) as Record<string, unknown>;
    expect(doc["node-label"]).toEqual(
      expect.arrayContaining([
        "app.kubernetes.io/managed-by=chant",
        "chant.intentius.io/stack=fountain",
        "chant.intentius.io/env=local",
      ]),
    );
  });

  it("never overwrites an author's own label with the marker", () => {
    const result = k3sSerializer.serialize(
      new Map<string, Declarable>([
        ["cp", new Server({ "node-label": ["chant.intentius.io/stack=mine"] })],
      ]),
      undefined,
      { ownership: { stack: "fountain", env: "local" } },
    );
    const text = typeof result === "string" ? result : (result as SerializerResult).primary;
    const doc = load(text) as Record<string, unknown>;
    const stackLabels = (doc["node-label"] as string[]).filter((l) =>
      l.startsWith("chant.intentius.io/stack="),
    );
    expect(stackLabels).toEqual(["chant.intentius.io/stack=mine"]);
  });

  it("quotes scalars YAML would otherwise mangle", () => {
    const { doc } = serializeOne({
      agent: new Agent({ server: "https://cp.example.com:6443" }),
    });
    expect(doc.server).toBe("https://cp.example.com:6443");
  });
});
