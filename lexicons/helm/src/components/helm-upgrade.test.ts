import { describe, test, expect } from "vitest";
import { createHelmUpgradeCapability, helmUpgradeCapability } from "./helm-upgrade";
import { helmCapabilityPlugin } from "./capability-plugin";
import { isCapabilityPlugin } from "@intentius/chant/components/capability-plugin";
import { readFileSync } from "node:fs";
import type { DeployContext } from "@intentius/chant/components/capability";

const ctx: DeployContext = { env: "local", component: "test" };

describe("helm-upgrade capability (#1495 piece 4)", () => {
  test("the plugin satisfies the CapabilityPlugin contract and registers the verb", () => {
    expect(isCapabilityPlugin(helmCapabilityPlugin)).toBe(true);
    expect(helmCapabilityPlugin.capabilities().map((c) => c.kind)).toContain("helm-upgrade");
  });

  test("the plugin's version is the lexicon package's own, not a literal (#1505)", () => {
    const { version } = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf-8"),
    ) as { version: string };
    expect(helmCapabilityPlugin.version).toBe(version);
  });

  test("run shells `helm upgrade --install` with the release, chart, and every declared flag", async () => {
    let seen = "";
    const cap = createHelmUpgradeCapability(async (cmd) => {
      seen = cmd;
      return { stdout: JSON.stringify({ name: "api", namespace: "prod", version: 3, info: { status: "deployed" } }) };
    });

    const out = await cap.run(ctx, {
      release: "api",
      chart: "./charts/api",
      namespace: "prod",
      createNamespace: true,
      values: ["values.yaml", "values.prod.yaml"],
      version: "1.2.3",
      wait: true,
      context: "k3d-test",
    });

    expect(seen).toBe(
      "helm upgrade --install 'api' './charts/api' -o json -n 'prod' --create-namespace " +
        "-f 'values.yaml' -f 'values.prod.yaml' --version '1.2.3' --wait --kube-context 'k3d-test'",
    );
    expect(out).toEqual({ release: "api", namespace: "prod", revision: 3, status: "deployed" });
  });

  test("non-JSON helm output still reports the release — the deploy already succeeded", async () => {
    const cap = createHelmUpgradeCapability(async () => ({ stdout: "Release \"api\" has been upgraded.\n" }));
    const out = await cap.run(ctx, { release: "api", chart: "repo/api", namespace: "prod" });
    expect(out).toEqual({ release: "api", namespace: "prod" });
  });

  test("rollback shells `helm rollback` scoped to the release and namespace — the native compensation", async () => {
    const commands: string[] = [];
    const cap = createHelmUpgradeCapability(async (cmd) => {
      commands.push(cmd);
      return { stdout: "" };
    });

    await cap.rollback!(ctx, { release: "api", chart: "repo/api", namespace: "prod", context: "k3d-test" });
    expect(commands).toEqual(["helm rollback 'api' -n 'prod' --kube-context 'k3d-test'"]);
  });

  test("no rollbackPolicy declared: a capability with a rollback method reads as native (COMP003)", () => {
    expect(helmUpgradeCapability.rollback).toBeDefined();
    expect(helmUpgradeCapability.rollbackPolicy).toBeUndefined();
  });

  test("a failing helm invocation rejects — a failed deploy must not report an outcome", async () => {
    const cap = createHelmUpgradeCapability(async () => {
      throw new Error("Error: UPGRADE FAILED: another operation is in progress");
    });
    await expect(cap.run(ctx, { release: "api", chart: "repo/api" })).rejects.toThrow(/UPGRADE FAILED/);
  });
});
