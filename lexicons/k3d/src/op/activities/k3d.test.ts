import { describe, test, expect, vi } from "vitest";
import {
  k3dUp,
  k3dUpCommand,
  k3dDownCommand,
  k3dExistsCommand,
  k3dKubeconfigWriteCommand,
  k3dContextName,
} from "./k3d";

// The return-shape tests below exercise k3dUp's already-exists skip path, so
// every command goes through this mock — no real cluster, no k3d binary.
vi.mock("node:child_process", () => {
  const custom = Symbol.for("nodejs.util.promisify.custom");
  const exec = ((_cmd: string, _opts: unknown, cb?: (...a: unknown[]) => void) => {
    cb?.(new Error("unmocked exec path"));
  }) as unknown as Record<symbol, unknown>;
  exec[custom] = async (cmd: string) => {
    if (cmd.startsWith("k3d cluster list")) return { stdout: "dev up\n", stderr: "" };
    if (cmd.startsWith("k3d kubeconfig write")) {
      return { stdout: "/home/user/.config/k3d/kubeconfig-dev.yaml\n", stderr: "" };
    }
    return { stdout: "", stderr: "" };
  };
  return { exec };
});

describe("k3dUpCommand (#704, kubeconfig defaults #1411)", () => {
  test("minimal — name only: safe kubeconfig defaults, --wait with a 120s timeout", () => {
    const cmd = k3dUpCommand({ name: "chant-local" });
    expect(cmd).toBe(
      "k3d cluster create chant-local --kubeconfig-update-default=false --kubeconfig-switch-context=false --wait --timeout 120s",
    );
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

describe("k3dUpCommand — kubeconfig flag mapping (#1411)", () => {
  test("no configFile, args unset: both flags forced to chant's safe false", () => {
    const cmd = k3dUpCommand({ name: "dev" });
    expect(cmd).toContain("--kubeconfig-update-default=false");
    expect(cmd).toContain("--kubeconfig-switch-context=false");
  });

  test("configFile present, args unset: no kubeconfig flags — the declared config governs", () => {
    // k3d gives CLI flags precedence over config, so emitting our defaults
    // here would silently override a config's declared `options.kubeconfig`.
    const cmd = k3dUpCommand({ name: "dev", configFile: "k3d.yaml" });
    expect(cmd).not.toContain("--kubeconfig-update-default");
    expect(cmd).not.toContain("--kubeconfig-switch-context");
  });

  test("explicit true is passed through, even alongside a configFile", () => {
    const cmd = k3dUpCommand({
      name: "dev",
      configFile: "k3d.yaml",
      updateDefaultKubeconfig: true,
      switchCurrentContext: true,
    });
    expect(cmd).toContain("--kubeconfig-update-default=true");
    expect(cmd).toContain("--kubeconfig-switch-context=true");
  });

  test("explicit false alongside a configFile is also passed (caller overrides config)", () => {
    const cmd = k3dUpCommand({
      name: "dev",
      configFile: "k3d.yaml",
      updateDefaultKubeconfig: false,
    });
    expect(cmd).toContain("--kubeconfig-update-default=false");
    // switchCurrentContext stays unset — the config governs it.
    expect(cmd).not.toContain("--kubeconfig-switch-context");
  });

  test("flags can be set independently without a configFile", () => {
    const cmd = k3dUpCommand({ name: "dev", switchCurrentContext: true });
    expect(cmd).toContain("--kubeconfig-update-default=false");
    expect(cmd).toContain("--kubeconfig-switch-context=true");
  });
});

describe("k3dUp result shape (#1411)", () => {
  test("default (kubeconfig untouched): returns context + dedicated kubeconfig path", async () => {
    // The mocked `cluster list` reports the cluster as existing, so this runs
    // the skip path; the mocked `kubeconfig write` prints a path.
    const result = await k3dUp({ name: "dev" });
    expect(result).toEqual({
      context: "k3d-dev",
      kubeconfigPath: "/home/user/.config/k3d/kubeconfig-dev.yaml",
    });
  });

  test("explicit updateDefaultKubeconfig: true — context only, no dedicated kubeconfig", async () => {
    const result = await k3dUp({ name: "dev", updateDefaultKubeconfig: true });
    expect(result).toEqual({ context: "k3d-dev" });
    expect(result.kubeconfigPath).toBeUndefined();
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

describe("k3dKubeconfigWriteCommand / k3dContextName (#1411)", () => {
  test("writes the named cluster's kubeconfig", () => {
    expect(k3dKubeconfigWriteCommand("chant-local")).toBe(
      "k3d kubeconfig write chant-local",
    );
  });

  test("context name is k3d-<name>", () => {
    expect(k3dContextName("chant-local")).toBe("k3d-chant-local");
  });
});
