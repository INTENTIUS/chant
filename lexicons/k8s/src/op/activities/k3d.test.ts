import { describe, test, expect } from "vitest";
import { k3dUpCommand, k3dDownCommand, k3dExistsCommand } from "./k3d";

describe("k3dUpCommand (#704)", () => {
  test("minimal — name only, defaults to --wait with a 120s timeout", () => {
    const cmd = k3dUpCommand({ name: "chant-local" });
    expect(cmd).toBe("k3d cluster create chant-local --wait --timeout 120s");
  });

  test("servers/agents/image flags", () => {
    const cmd = k3dUpCommand({
      name: "dev",
      servers: 1,
      agents: 2,
      image: "rancher/k3s:v1.31.4-k3s1",
    });
    expect(cmd).toContain("--servers 1");
    expect(cmd).toContain("--agents 2");
    expect(cmd).toContain("--image rancher/k3s:v1.31.4-k3s1");
  });

  test("each port becomes a quoted -p flag", () => {
    const cmd = k3dUpCommand({
      name: "dev",
      ports: ["8080:80@loadbalancer", "8443:443@loadbalancer"],
    });
    expect(cmd).toContain('-p "8080:80@loadbalancer"');
    expect(cmd).toContain('-p "8443:443@loadbalancer"');
  });

  test("registry and config file", () => {
    const cmd = k3dUpCommand({
      name: "dev",
      registryCreate: "chant-registry",
      configFile: "k3d.yaml",
    });
    expect(cmd).toContain("--registry-create chant-registry");
    expect(cmd).toContain("--config k3d.yaml");
  });

  test("custom timeout overrides the default", () => {
    const cmd = k3dUpCommand({ name: "dev", timeout: "300s" });
    expect(cmd).toContain("--timeout 300s");
    expect(cmd).not.toContain("120s");
  });

  test("zero servers is emitted (not dropped as falsy)", () => {
    // servers: 0 is unusual but must round-trip — guarded by `!== undefined`.
    const cmd = k3dUpCommand({ name: "dev", servers: 0 });
    expect(cmd).toContain("--servers 0");
  });
});

describe("k3dDownCommand (#704)", () => {
  test("deletes the named cluster", () => {
    expect(k3dDownCommand({ name: "chant-local" })).toBe(
      "k3d cluster delete chant-local",
    );
  });
});

describe("k3dExistsCommand (#704)", () => {
  test("lists a single cluster with no headers for an emptiness check", () => {
    expect(k3dExistsCommand("chant-local")).toBe(
      "k3d cluster list chant-local --no-headers",
    );
  });
});
