/**
 * `helmInstall` release recording (#1243, epic #1228 phase 4).
 *
 * A helm deploy through a chant op used to run `helm upgrade --install` and
 * return void — no trace in the release ledger. It now computes an
 * *input-side* digest (chart, chart version, resolved values, declared
 * capability profile) and appends a `ReleaseRecord` keyed by it after a
 * successful deploy, via the same `maybeRecordAutoRelease` convention the
 * `chant run --components` post-run step uses.
 *
 * The helm and kubectl binaries are scripted doubles (promisify-aware exec
 * mock) and the ledger append is a captured mock — no cluster, no git, no
 * helm. The kubectl double is what the deploy-time capability-profile
 * assertion (#1244) probes as the "live cluster".
 */
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const helm = vi.hoisted(() => ({
  calls: [] as string[],
  fail: false,
}));

/** Scripted kubectl double for the capability probe (#1244) — what the "live cluster" reports. */
const cluster = vi.hoisted(() => ({
  serverVersion: { major: "1", minor: "33", gitVersion: "v1.33.6+k3s1" } as Record<string, unknown>,
  apiVersions: ["v1", "apps/v1", "batch/v1"],
  probeFail: false,
}));

const ledger = vi.hoisted(() => ({
  calls: [] as Array<Record<string, unknown>>,
  outcome: undefined as unknown,
}));

vi.mock("node:child_process", () => {
  const custom = Symbol.for("nodejs.util.promisify.custom");
  const exec = ((_cmd: string, _opts: unknown, cb?: (...a: unknown[]) => void) => {
    cb?.(new Error("unmocked exec path"));
  }) as unknown as Record<symbol, unknown>;
  exec[custom] = async (cmd: string) => {
    helm.calls.push(cmd);
    if (cmd.startsWith("kubectl")) {
      if (cluster.probeFail) {
        throw new Error("The connection to the server localhost:8080 was refused");
      }
      if (cmd.startsWith("kubectl version")) {
        return {
          stdout: JSON.stringify({ clientVersion: {}, serverVersion: cluster.serverVersion }),
          stderr: "",
        };
      }
      if (cmd.startsWith("kubectl api-versions")) {
        return { stdout: cluster.apiVersions.join("\n") + "\n", stderr: "" };
      }
      throw new Error(`unscripted kubectl invocation: ${cmd}`);
    }
    if (helm.fail) throw new Error("Error: UPGRADE FAILED: context deadline exceeded");
    return { stdout: "Release deployed\n", stderr: "" };
  };
  return { exec };
});

vi.mock("@intentius/chant/components/auto-release", () => ({
  maybeRecordAutoRelease: async (run: Record<string, unknown>) => {
    ledger.calls.push(run);
    return (
      ledger.outcome ?? {
        recorded: true,
        commit: "abc1234",
        record: {
          version: 1,
          component: run.component,
          env: run.env,
          digest: run.digest,
          gitSha: "deadbeef",
          runId: run.runId,
          timestamp: "2026-08-24T00:00:00.000Z",
          actor: "tester",
        },
      }
    );
  },
}));

import { helmInstall, helmInstallInputDigest } from "./helm";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "chant-helm-activity-"));
  helm.calls = [];
  helm.fail = false;
  cluster.serverVersion = { major: "1", minor: "33", gitVersion: "v1.33.6+k3s1" };
  cluster.apiVersions = ["v1", "apps/v1", "batch/v1"];
  cluster.probeFail = false;
  ledger.calls = [];
  ledger.outcome = undefined;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function valuesFile(name: string, content: string): string {
  const file = join(dir, name);
  writeFileSync(file, content);
  return file;
}

describe("helmInstallInputDigest", () => {
  test("digests the canonical JSON of { chart, chartVersion, values } — pinned against a hand-computed hash", () => {
    const values = valuesFile("values.yaml", "b: 2\na: 1\n");
    const digest = helmInstallInputDigest({
      name: "web",
      chart: "./chart",
      chartVersion: "1.2.3",
      values,
    });
    // Independently derived: canonical JSON sorts keys, so the exact bytes
    // are known without calling canonicalJson — a non-circular anchor.
    const canonical = '{"chart":"./chart","chartVersion":"1.2.3","values":{"a":1,"b":2}}';
    const expected = `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
    expect(digest).toBe(expected);
  });

  test("stable across value key order", () => {
    const a = valuesFile("a.yaml", "replicas: 3\nimage:\n  tag: v1\n  repo: web\n");
    const b = valuesFile("b.yaml", "image:\n  repo: web\n  tag: v1\nreplicas: 3\n");
    const args = { name: "web", chart: "./chart", chartVersion: "1.2.3" };
    expect(helmInstallInputDigest({ ...args, values: a })).toBe(
      helmInstallInputDigest({ ...args, values: b }),
    );
  });

  test("changes when a value changes", () => {
    const v1 = valuesFile("v1.yaml", "replicas: 3\n");
    const v2 = valuesFile("v2.yaml", "replicas: 4\n");
    const args = { name: "web", chart: "./chart" };
    expect(helmInstallInputDigest({ ...args, values: v1 })).not.toBe(
      helmInstallInputDigest({ ...args, values: v2 }),
    );
  });

  test("changes when the chart version changes", () => {
    const values = valuesFile("values.yaml", "replicas: 3\n");
    expect(
      helmInstallInputDigest({ name: "web", chart: "./chart", values, chartVersion: "1.2.3" }),
    ).not.toBe(
      helmInstallInputDigest({ name: "web", chart: "./chart", values, chartVersion: "1.2.4" }),
    );
  });

  test("--set entries resolve into the values at their dotted path, set winning over the file", () => {
    const inFile = valuesFile("in-file.yaml", "image:\n  tag: v2\n");
    const overridden = valuesFile("overridden.yaml", "image:\n  tag: v1\n");
    expect(
      helmInstallInputDigest({
        name: "web",
        chart: "./chart",
        values: overridden,
        set: { "image.tag": "v2" },
      }),
    ).toBe(helmInstallInputDigest({ name: "web", chart: "./chart", values: inFile }));
  });

  test("a declared capability profile joins the digest, order-insensitively for apiVersions", () => {
    const values = valuesFile("values.yaml", "replicas: 3\n");
    const bare = helmInstallInputDigest({ name: "web", chart: "./chart", values });
    const profiled = helmInstallInputDigest({
      name: "web",
      chart: "./chart",
      values,
      capabilityProfile: { kubeVersion: "1.33.6", apiVersions: ["batch/v1", "apps/v1"] },
    });
    expect(profiled).not.toBe(bare);
    expect(
      helmInstallInputDigest({
        name: "web",
        chart: "./chart",
        values,
        capabilityProfile: { kubeVersion: "1.33.6", apiVersions: ["apps/v1", "batch/v1"] },
      }),
    ).toBe(profiled);
  });
});

describe("helmInstall release recording (#1243)", () => {
  test("a successful deploy appends exactly one record carrying the input digest", async () => {
    const values = valuesFile("values.yaml", "b: 2\na: 1\n");
    const args = { name: "web", chart: "./chart", chartVersion: "1.2.3", values };
    const result = await helmInstall(args);

    expect(helm.calls).toHaveLength(1);
    expect(helm.calls[0]).toContain("helm upgrade --install --wait web ./chart");
    expect(helm.calls[0]).toContain("--version 1.2.3");

    const expected = helmInstallInputDigest(args);
    expect(ledger.calls).toHaveLength(1);
    expect(ledger.calls[0]).toMatchObject({
      component: "web",
      env: "local",
      success: true,
      digest: expected,
    });
    expect(result.inputDigest).toBe(expected);
    expect(result.release.recorded).toBe(true);
  });

  test("component/env/runId args flow into the record when declared", async () => {
    await helmInstall({
      name: "web",
      chart: "./chart",
      component: "search-service",
      env: "staging",
      runId: "gha-42",
    });
    expect(ledger.calls[0]).toMatchObject({
      component: "search-service",
      env: "staging",
      runId: "gha-42",
    });
  });

  test("a failed deploy appends nothing", async () => {
    helm.fail = true;
    await expect(helmInstall({ name: "web", chart: "./chart" })).rejects.toThrow("UPGRADE FAILED");
    expect(ledger.calls).toHaveLength(0);
  });

  test("a ledger-append failure warns and the activity still succeeds", async () => {
    ledger.outcome = { recorded: false, reason: "error", error: "push to chant/lifecycle failed" };
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await helmInstall({ name: "web", chart: "./chart" });

    expect(result.release).toEqual({
      recorded: false,
      reason: "error",
      error: "push to chant/lifecycle failed",
    });
    const warning = warn.mock.calls.map((c) => String(c[0])).find((m) => m.includes("no release record"));
    expect(warning).toContain('helm release "web" deployed, but no release record was appended');
    expect(warning).toContain("push to chant/lifecycle failed");
  });

  test("recordRelease: false opts out without warning", async () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await helmInstall({ name: "web", chart: "./chart", recordRelease: false });
    expect(ledger.calls).toHaveLength(0);
    expect(result.release).toEqual({ recorded: false, reason: "opted-out" });
    expect(warn.mock.calls.map((c) => String(c[0]))).not.toContainEqual(
      expect.stringContaining("no release record"),
    );
  });
});

describe("capability profile assertion at deploy time (#1244)", () => {
  const prod = { name: "prod", kubeVersion: "1.33.6", apiVersions: ["apps/v1", "batch/v1"] };

  function helmMutations(): string[] {
    return helm.calls.filter((cmd) => cmd.startsWith("helm "));
  }

  function kubectlProbes(): string[] {
    return helm.calls.filter((cmd) => cmd.startsWith("kubectl "));
  }

  test("a matching profile deploys, probing before any helm mutation", async () => {
    const result = await helmInstall({ name: "web", chart: "./chart", capabilityProfile: prod });

    expect(kubectlProbes().sort()).toEqual(["kubectl api-versions", "kubectl version -o json"]);
    expect(helmMutations()).toHaveLength(1);
    const firstHelm = helm.calls.findIndex((cmd) => cmd.startsWith("helm "));
    for (const probe of kubectlProbes()) {
      expect(helm.calls.indexOf(probe)).toBeLessThan(firstHelm);
    }
    expect(result.profileAssertion).toEqual({ matched: true });
    expect(ledger.calls[0]).not.toHaveProperty("profileOverride", expect.anything());
  });

  test("patch skew within the declared major.minor is not a divergence", async () => {
    cluster.serverVersion = { major: "1", minor: "33", gitVersion: "v1.33.1" };
    const result = await helmInstall({
      name: "web",
      chart: "./chart",
      capabilityProfile: { kubeVersion: "1.33.6" },
    });
    expect(result.profileAssertion).toEqual({ matched: true });
  });

  test("a kubeVersion mismatch refuses before any helm mutation, naming both versions", async () => {
    await expect(
      helmInstall({
        name: "web",
        chart: "./chart",
        capabilityProfile: { name: "staging", kubeVersion: "1.31.4" },
      }),
    ).rejects.toThrow(/profile declares 1\.31\.4 \(1\.31\).*cluster runs v1\.33\.6\+k3s1 \(1\.33\)/s);

    expect(helmMutations()).toHaveLength(0);
    expect(ledger.calls).toHaveLength(0);
  });

  test("the mismatch names the profile and offers the recorded override", async () => {
    const args = {
      name: "web",
      chart: "./chart",
      capabilityProfile: { name: "staging", kubeVersion: "1.31.4" },
    };
    await expect(helmInstall(args)).rejects.toThrow('capability profile "staging"');
    await expect(helmInstall(args)).rejects.toThrow("overrideProfileAssertion");
  });

  test("a profile-declared apiVersion the cluster does not serve refuses, naming it", async () => {
    await expect(
      helmInstall({
        name: "web",
        chart: "./chart",
        capabilityProfile: {
          kubeVersion: "1.33.6",
          apiVersions: ["apps/v1", "monitoring.coreos.com/v1"],
        },
      }),
    ).rejects.toThrow(
      "apiVersion monitoring.coreos.com/v1: declared by the profile, not served by the cluster",
    );
    expect(helmMutations()).toHaveLength(0);
  });

  test("an unreachable cluster refuses — a deploy that cannot verify its profile does not proceed", async () => {
    cluster.probeFail = true;
    await expect(
      helmInstall({ name: "web", chart: "./chart", capabilityProfile: prod }),
    ).rejects.toThrow(/capabilities could not be verified.*connection to the server/s);
    expect(helmMutations()).toHaveLength(0);
    expect(ledger.calls).toHaveLength(0);
  });

  test("no declared profile probes nothing — today's behavior, kubectl never invoked", async () => {
    await helmInstall({ name: "web", chart: "./chart" });
    expect(kubectlProbes()).toHaveLength(0);
    expect(helm.calls).toHaveLength(1);
  });

  test("a profile declaring no facts probes nothing", async () => {
    const result = await helmInstall({
      name: "web",
      chart: "./chart",
      capabilityProfile: { apiVersions: [] },
    });
    expect(kubectlProbes()).toHaveLength(0);
    expect(result.profileAssertion).toBeUndefined();
  });

  test("overrideProfileAssertion deploys through a mismatch, warns, and records the override in the release record", async () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await helmInstall({
      name: "web",
      chart: "./chart",
      capabilityProfile: { name: "staging", kubeVersion: "1.31.4", apiVersions: ["missing.io/v1"] },
      overrideProfileAssertion: true,
    });

    expect(helmMutations()).toHaveLength(1);
    expect(result.profileAssertion).toEqual({
      matched: false,
      overridden: true,
      divergences: [
        "kubeVersion: profile declares 1.31.4 (1.31), cluster runs v1.33.6+k3s1 (1.33)",
        "apiVersion missing.io/v1: declared by the profile, not served by the cluster",
      ],
    });

    const warning = warn.mock.calls
      .map((c) => String(c[0]))
      .find((m) => m.includes("despite capability profile"));
    expect(warning).toContain('"staging"');
    expect(warning).toContain("kubeVersion: profile declares 1.31.4");

    expect(ledger.calls).toHaveLength(1);
    expect(ledger.calls[0].profileOverride).toBe(
      "kubeVersion: profile declares 1.31.4 (1.31), cluster runs v1.33.6+k3s1 (1.33); " +
        "apiVersion missing.io/v1: declared by the profile, not served by the cluster",
    );
  });

  test("overrideProfileAssertion also covers an unprobeable cluster, recording the probe failure", async () => {
    cluster.probeFail = true;
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await helmInstall({
      name: "web",
      chart: "./chart",
      capabilityProfile: prod,
      overrideProfileAssertion: true,
    });
    expect(helmMutations()).toHaveLength(1);
    expect(result.profileAssertion).toMatchObject({ matched: false, overridden: true });
    expect(String(ledger.calls[0].profileOverride)).toContain("capability probe failed:");
    expect(warn.mock.calls.map((c) => String(c[0])).join("\n")).toContain("capability probe failed:");
  });

  test("a match with the override flag set records no override", async () => {
    await helmInstall({
      name: "web",
      chart: "./chart",
      capabilityProfile: prod,
      overrideProfileAssertion: true,
    });
    expect(ledger.calls[0].profileOverride).toBeUndefined();
  });
});
