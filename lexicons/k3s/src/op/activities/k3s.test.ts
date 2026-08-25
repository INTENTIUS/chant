import { describe, test, expect, vi } from "vitest";
import {
  k3sInstall,
  k3sUninstall,
  k3sInstallCommand,
  k3sInstallEnv,
  k3sUninstallCommand,
  k3sUninstallScript,
  k3sVersionCommand,
  parseK3sVersion,
} from "./k3s";
import { K3S_VERSION } from "../../spec/fetch";

// Every command below goes through this mock — no real k3s installer, no
// real host. `execCalls` records the exact (cmd, opts) pairs so the install/
// uninstall idempotence paths can be asserted precisely.
const execCalls: Array<{ cmd: string; opts: unknown }> = [];
let versionReply: { stdout: string; stderr: string } | Error = new Error("k3s: command not found");
let uninstallReply: { stdout: string; stderr: string } = { stdout: "", stderr: "" };

vi.mock("node:child_process", () => {
  const custom = Symbol.for("nodejs.util.promisify.custom");
  const exec = ((_cmd: string, _opts: unknown, cb?: (...a: unknown[]) => void) => {
    cb?.(new Error("unmocked exec path"));
  }) as unknown as Record<symbol, unknown>;
  exec[custom] = async (cmd: string, opts?: unknown) => {
    execCalls.push({ cmd, opts });
    if (cmd === "k3s --version") {
      if (versionReply instanceof Error) throw versionReply;
      return versionReply;
    }
    if (cmd.startsWith("test -x")) return uninstallReply;
    return { stdout: "", stderr: "" };
  };
  return { exec };
});

describe("k3sInstallCommand (#1601)", () => {
  test("server role — curl installer piped into `sh -s - server --config <file>`", () => {
    const cmd = k3sInstallCommand({ role: "server", configFile: "/etc/rancher/k3s/config.yaml" });
    expect(cmd).toBe(
      "curl -sfL https://get.k3s.io | sh -s - server --config /etc/rancher/k3s/config.yaml",
    );
  });

  test("agent role", () => {
    const cmd = k3sInstallCommand({ role: "agent", configFile: "/etc/rancher/k3s/config.yaml" });
    expect(cmd).toContain("sh -s - agent --config");
  });

  test("never interpolates a token or version into the command string", () => {
    const cmd = k3sInstallCommand({
      role: "server",
      configFile: "/etc/rancher/k3s/config.yaml",
      version: "v9.9.9+k3s1",
      tokenFile: "/etc/rancher/k3s/agent-token",
    });
    expect(cmd).not.toContain("v9.9.9");
    expect(cmd).not.toContain("token");
    expect(cmd).not.toContain("TOKEN");
  });
});

describe("k3sInstallEnv — the token boundary (#1601)", () => {
  test("defaults INSTALL_K3S_VERSION to the lexicon pin, no K3S_TOKEN_FILE without a tokenFile", () => {
    const env = k3sInstallEnv({ role: "server", configFile: "config.yaml" });
    expect(env).toEqual({ INSTALL_K3S_VERSION: K3S_VERSION });
    expect(env.K3S_TOKEN_FILE).toBeUndefined();
  });

  test("an explicit version overrides the pin", () => {
    const env = k3sInstallEnv({ role: "server", configFile: "config.yaml", version: "v9.9.9+k3s1" });
    expect(env.INSTALL_K3S_VERSION).toBe("v9.9.9+k3s1");
  });

  test("tokenFile becomes K3S_TOKEN_FILE — a path, never a literal secret value", () => {
    const env = k3sInstallEnv({
      role: "agent",
      configFile: "config.yaml",
      tokenFile: "/etc/rancher/k3s/agent-token",
    });
    expect(env.K3S_TOKEN_FILE).toBe("/etc/rancher/k3s/agent-token");
  });

  test("K3sInstallArgs has no literal-token field at all — a TypeScript surface check", () => {
    // If a `token` property is ever added to K3sInstallArgs, this object
    // literal starts compiling and the guard below no longer proves anything.
    // @ts-expect-error — token is not part of K3sInstallArgs
    const args: import("./k3s").K3sInstallArgs = { role: "server", configFile: "c.yaml", token: "shhh" };
    void args;
  });
});

describe("k3sUninstallCommand / k3sUninstallScript (#1601)", () => {
  test("server role runs the server uninstall script, guarded by -x", () => {
    expect(k3sUninstallScript("server")).toBe("/usr/local/bin/k3s-uninstall.sh");
    expect(k3sUninstallCommand({ role: "server" })).toBe(
      'test -x /usr/local/bin/k3s-uninstall.sh && /usr/local/bin/k3s-uninstall.sh || echo "k3s server already uninstalled"',
    );
  });

  test("agent role runs the agent uninstall script", () => {
    expect(k3sUninstallScript("agent")).toBe("/usr/local/bin/k3s-agent-uninstall.sh");
    expect(k3sUninstallCommand({ role: "agent" })).toContain("k3s-agent-uninstall.sh");
  });
});

describe("k3sVersionCommand / parseK3sVersion (#1601)", () => {
  test("version command", () => {
    expect(k3sVersionCommand()).toBe("k3s --version");
  });

  test("parses the version out of `k3s --version` output", () => {
    const stdout = "k3s version v1.36.3+k3s1 (abc1234)\ngo version go1.23.1\n";
    expect(parseK3sVersion(stdout)).toBe("v1.36.3+k3s1");
  });

  test("returns undefined for unrecognized output", () => {
    expect(parseK3sVersion("bash: k3s: command not found\n")).toBeUndefined();
  });
});

describe("k3sInstall (#1601)", () => {
  test("already-installed matching version: skips install, no INSTALL_K3S_VERSION exec", async () => {
    execCalls.length = 0;
    versionReply = { stdout: `k3s version ${K3S_VERSION} (abc1234)\n`, stderr: "" };
    const result = await k3sInstall({ role: "server", configFile: "/etc/rancher/k3s/config.yaml" });
    expect(result).toEqual({ version: K3S_VERSION, installed: false });
    expect(execCalls).toHaveLength(1);
    expect(execCalls[0].cmd).toBe("k3s --version");
  });

  test("no k3s present: runs the installer with the version pin in env, not the command string", async () => {
    execCalls.length = 0;
    versionReply = new Error("k3s: command not found");
    const result = await k3sInstall({ role: "server", configFile: "/etc/rancher/k3s/config.yaml" });
    expect(result).toEqual({ version: K3S_VERSION, installed: true });
    expect(execCalls).toHaveLength(2);
    expect(execCalls[0].cmd).toBe("k3s --version");
    expect(execCalls[1].cmd).toBe(
      "curl -sfL https://get.k3s.io | sh -s - server --config /etc/rancher/k3s/config.yaml",
    );
    const opts = execCalls[1].opts as { env?: Record<string, string> };
    expect(opts.env?.INSTALL_K3S_VERSION).toBe(K3S_VERSION);
  });

  test("mismatched version installed: reinstalls to the target version", async () => {
    execCalls.length = 0;
    versionReply = { stdout: "k3s version v1.30.0+k3s1 (abc1234)\n", stderr: "" };
    const result = await k3sInstall({ role: "agent", configFile: "/etc/rancher/k3s/config.yaml" });
    expect(result).toEqual({ version: K3S_VERSION, installed: true });
    expect(execCalls).toHaveLength(2);
  });

  test("a tokenFile is threaded into the installer's env as K3S_TOKEN_FILE", async () => {
    execCalls.length = 0;
    versionReply = new Error("k3s: command not found");
    await k3sInstall({
      role: "agent",
      configFile: "/etc/rancher/k3s/config.yaml",
      tokenFile: "/etc/rancher/k3s/agent-token",
    });
    const opts = execCalls[1].opts as { env?: Record<string, string> };
    expect(opts.env?.K3S_TOKEN_FILE).toBe("/etc/rancher/k3s/agent-token");
  });
});

describe("k3sUninstall (#1601)", () => {
  test("runs the uninstall command for the given role", async () => {
    execCalls.length = 0;
    uninstallReply = { stdout: "k3s uninstalled\n", stderr: "" };
    await k3sUninstall({ role: "server" });
    expect(execCalls).toHaveLength(1);
    expect(execCalls[0].cmd).toContain("k3s-uninstall.sh");
  });

  test("never-installed host: the guarded command still resolves (no-op success)", async () => {
    execCalls.length = 0;
    uninstallReply = { stdout: "k3s server already uninstalled\n", stderr: "" };
    await expect(k3sUninstall({ role: "server" })).resolves.toBeUndefined();
  });
});
