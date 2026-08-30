/**
 * Typed step-builder wrappers (chant #1288 Stage 2) — see
 * `lexicons/k8s/src/op/builders.test.ts`'s module doc for what's asserted
 * and why.
 */

import { describe, test, expect } from "vitest";
import { k3sInstall as k3sInstallOld, k3sUninstall as k3sUninstallOld, stepOutput, type StepOutputRef } from "@intentius/chant/op";
import { k3sInstall, k3sUninstall } from "./builders";

describe("k3s typed step builders (#1288 Stage 2)", () => {
  test("k3sInstall: identical ActivityStep to core's original", () => {
    const opts = { configFile: "dist/config.yaml" };
    expect(k3sInstall("server", opts)).toEqual(k3sInstallOld("server", opts));
    const optsWithVersion = { configFile: "dist/config.yaml", version: "v1.31.4+k3s1", tokenFile: "/etc/k3s-token" };
    expect(k3sInstall("agent", optsWithVersion)).toEqual(k3sInstallOld("agent", optsWithVersion));
  });

  test("k3sUninstall: identical ActivityStep to core's original", () => {
    expect(k3sUninstall("server")).toEqual(k3sUninstallOld("server"));
  });

  test("k3sInstall: accepts a StepOutputRef in a typed slot", () => {
    const ref = stepOutput("write-config", "path");
    const step = k3sInstall("server", { configFile: ref });
    expect(step.args?.configFile).toBe(ref);
  });

  test("k3sInstall: .out is reachable when an id is given", () => {
    const step = k3sInstall("server", { configFile: "dist/config.yaml", id: "install" });
    const ref: StepOutputRef = step.out.version;
    expect(ref.step).toBe("install");
    expect(ref.path).toBe("version");
  });
});

// ── Compile-time-only: authoring-time type errors (never executed) ──────────
function _typeChecksOnly(): void {
  // @ts-expect-error — configFile is required (the activity fails without
  // it); omitting opts entirely is no longer a way around that.
  k3sInstall("server");

  // @ts-expect-error — "configfile" (wrong case) is not a key of K3sInstallArgs.
  k3sInstall("server", { configfile: "dist/config.yaml" });

  // @ts-expect-error — role must be "server" | "agent", not an arbitrary string.
  k3sInstall("controller", { configFile: "dist/config.yaml" });
}
void _typeChecksOnly;
