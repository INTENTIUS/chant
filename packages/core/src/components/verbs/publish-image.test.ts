import { describe, expect, it } from "vitest";
import {
  RegistryBackendError,
  createPublishImageCapability,
  selectRegistryBackend,
  type RegistryLoginBackend,
} from "./publish-image";
import type { DockerClient } from "./cloud-executor";
import { CapabilityRegistry } from "../capability";
import { registerCapabilityPlugins, DuplicateCapabilityKindError } from "../capability-plugin-loader";
import { starterCapabilityPlugin } from "../starter-plugin";
import type { CapabilityPlugin } from "../capability-plugin";

function backend(name: string, host: RegExp, log: string[] = []): RegistryLoginBackend {
  return { name, matches: (r) => host.test(r), login: async (r) => void log.push(`${name}:${r}`) };
}

function fakeDocker(log: string[] = []): DockerClient {
  return {
    build: async () => ({ digest: "sha256:b" }),
    save: async () => {},
    load: async () => ({ digest: "local:1" }),
    tag: async () => void log.push("tag"),
    push: async () => ({ digest: "sha256:abc" }),
    remoteDigest: async () => "sha256:abc",
  };
}

const ctx = { env: "dev", component: "svc" };

describe("selectRegistryBackend", () => {
  const ecr = backend("ecr", /\.ecr\./);
  const acr = backend("acr", /azurecr/);
  it("picks by registry host", () => {
    expect(selectRegistryBackend([ecr, acr], "x.azurecr.io").name).toBe("acr");
  });
  it("an explicit name wins over the host", () => {
    expect(selectRegistryBackend([ecr, acr], "x.azurecr.io", "ecr").name).toBe("ecr");
  });
  it("rejects an unknown name, listing what is available", () => {
    expect(() => selectRegistryBackend([ecr], "h", "acr")).toThrow(/no registry backend "acr".*ecr/);
  });
  it("falls back to the only backend", () => {
    expect(selectRegistryBackend([ecr], "registry.example.com").name).toBe("ecr");
  });
  it("is ambiguous with several backends and no match", () => {
    expect(() => selectRegistryBackend([ecr, acr], "registry.example.com")).toThrow(RegistryBackendError);
  });
});

describe("core publish-image", () => {
  it("logs in through the backend the environment names", async () => {
    const log: string[] = [];
    const cap = createPublishImageCapability({
      docker: fakeDocker(),
      backends: [backend("ecr", /\.ecr\./, log), backend("acr", /azurecr/, log)],
    });
    const out = await cap.run({ ...ctx, vars: { publish: { backend: "acr" } } }, { from: "a.tar", to: "reg.example.com/app/" });
    expect(log).toEqual(["acr:reg.example.com"]);
    expect(out).toMatchObject({ digest: "sha256:abc", uri: "reg.example.com/app@sha256:abc" });
  });

  it("the registry rebinds the verb to the backends of every loaded plugin", () => {
    const seen: string[][] = [];
    const consumer = {
      kind: "publish-image",
      run: async () => ({}),
      withRegistryBackends(bs: readonly RegistryLoginBackend[]) {
        seen.push(bs.map((b) => b.name));
        return { kind: "publish-image", run: async () => ({}) };
      },
    };
    const plugin = (name: string, b?: RegistryLoginBackend): CapabilityPlugin => ({
      name,
      version: "0",
      capabilities: () => (name === "core" ? ([consumer] as never) : []),
      ...(b ? { registryBackends: () => [b] } : {}),
    });
    registerCapabilityPlugins(new CapabilityRegistry(), [
      plugin("core"),
      plugin("aws", backend("ecr", /\.ecr\./)),
      plugin("azure", backend("acr", /azurecr/)),
    ]);
    expect(seen).toEqual([["ecr", "acr"]]);
  });

  it("the starter plugin carries the real publish-image verb", () => {
    expect(starterCapabilityPlugin.capabilities().map((c) => c.kind)).toContain("publish-image");
  });

  it("a plugin that registers publish-image itself still collides", () => {
    const dup: CapabilityPlugin = {
      name: "dup",
      version: "0",
      capabilities: () => [{ kind: "publish-image", run: async () => ({}) }] as never,
    };
    expect(() => registerCapabilityPlugins(new CapabilityRegistry(), [starterCapabilityPlugin, dup])).toThrow(
      DuplicateCapabilityKindError,
    );
  });
});
