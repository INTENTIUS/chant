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
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const helm = vi.hoisted(() => ({
  calls: [] as string[],
  fail: false,
  /** Scripted `helm get metadata -o json` body (pinned path, #1242). */
  metadata: undefined as Record<string, unknown> | undefined,
  metadataFail: false,
  /**
   * Wrapper-chart snapshot captured at `helm upgrade` time (#1242) — the
   * activity deletes its temp dir afterwards, so the double reads the files
   * the moment helm would. Keys are chart-relative paths.
   */
  wrapperFiles: undefined as Record<string, string> | undefined,
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

vi.mock("node:child_process", async () => {
  const { readFileSync, readdirSync, statSync } = await import("node:fs");
  const { join } = await import("node:path");
  const snapshotDir = (dir: string, rel = ""): Record<string, string> => {
    const files: Record<string, string> = {};
    for (const entry of readdirSync(join(dir, rel))) {
      const relPath = rel ? `${rel}/${entry}` : entry;
      if (statSync(join(dir, relPath)).isDirectory()) {
        Object.assign(files, snapshotDir(dir, relPath));
      } else {
        files[relPath] = readFileSync(join(dir, relPath), "utf8");
      }
    }
    return files;
  };
  const custom = Symbol.for("nodejs.util.promisify.custom");
  const exec = ((_cmd: string, _opts: unknown, cb?: (...a: unknown[]) => void) => {
    cb?.(new Error("unmocked exec path"));
  }) as unknown as Record<symbol, unknown>;
  exec[custom] = async (cmd: string) => {
    helm.calls.push(cmd);
    if (cmd.startsWith("helm get metadata")) {
      if (helm.metadataFail) throw new Error("Error: release: not found");
      return { stdout: JSON.stringify(helm.metadata ?? {}), stderr: "" };
    }
    if (cmd.startsWith("helm upgrade")) {
      // Pinned installs pass a chart directory; snapshot it before the
      // activity's cleanup so tests can assert the exact bytes helm saw.
      const chartArg = cmd.split(" ")[5];
      try {
        helm.wrapperFiles = snapshotDir(chartArg);
      } catch {
        helm.wrapperFiles = undefined; // unpinned: chart ref is not a local dir
      }
    }
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

import {
  helmInstall,
  helmInstallInputDigest,
  PinnedInstallInputError,
  PinnedProfileMismatchError,
  PinnedRenderIntegrityError,
  PinnedRenderNotFoundError,
} from "./helm";
import { loadRenderContent, persistHelmRender, type RenderManifest } from "../../render-store";
import { routeRender } from "../../render-wrapper";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "chant-helm-activity-"));
  helm.calls = [];
  helm.fail = false;
  helm.metadata = undefined;
  helm.metadataFail = false;
  helm.wrapperFiles = undefined;
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

// ── pinned install path (#1242) ───────────────────────────────────────────

describe("pinned install path (#1242)", () => {
  const rendered = [
    "---",
    "# Source: umb/charts/kid/crds/kidcrd.yaml",
    "apiVersion: apiextensions.k8s.io/v1",
    "kind: CustomResourceDefinition",
    "metadata:",
    "  name: kidthings.example.com",
    "spec:",
    "  group: example.com",
    "  names:",
    "    kind: KidThing",
    "---",
    "# Source: umb/templates/hook-job.yaml",
    "apiVersion: batch/v1",
    "kind: Job",
    "metadata:",
    "  name: setup",
    "  annotations:",
    '    "helm.sh/hook": pre-install',
    "---",
    "# Source: umb/templates/cm.yaml",
    "apiVersion: v1",
    "kind: ConfigMap",
    "metadata:",
    "  name: alerts",
    "data:",
    '  template: "summary: {{ $labels.instance }} down"',
  ].join("\n");

  /** Persist the fixture render into a per-test store and return its manifest. */
  function storeRender(overrides?: { releaseName?: string }): { manifest: RenderManifest; root: string } {
    const root = join(dir, "render-store");
    const { manifest } = persistHelmRender({
      rendered,
      releaseName: overrides?.releaseName ?? "web",
      chart: "umb",
      chartVersion: "0.1.0",
      values: { replicas: 3 },
      capabilityProfile: { name: "k3d-local", kubeVersion: "1.33.6", apiVersions: ["apps/v1"] },
      root,
    });
    return { manifest, root };
  }

  test("installs the recorded bytes: wrapper argv, CRDs in crds/, docs shipped verbatim through .Files.Get shims", async () => {
    const { manifest, root } = storeRender();
    helm.metadata = { name: "web", revision: 2, version: "0.1.0", namespace: "default" };

    const result = await helmInstall({ name: "web", contentDigest: manifest.contentDigest, renderStoreRoot: root });

    // argv: the wrapper directory is the install input — no chart ref, no
    // values, no --set, no --version; nothing helm could re-render from.
    const upgrade = helm.calls.find((c) => c.startsWith("helm upgrade"));
    expect(upgrade).toMatch(/^helm upgrade --install --wait web \S*chant-helm-pinned-[^ ]+$/);

    // The bytes helm saw are the stored canonical documents, routed: the CRD
    // verbatim in crds/, every other doc verbatim in manifests/ with a
    // .Files.Get shim in templates/ (never re-templated — the ConfigMap
    // carries literal `{{ $labels }}` bytes).
    const files = helm.wrapperFiles!;
    const canonical = loadRenderContent(manifest.contentDigest, { root })!;
    const routed = routeRender(canonical, { chart: manifest.chart, chartVersion: manifest.chartVersion });
    const crdFile = Object.keys(files).find((f) => f.startsWith("crds/"))!;
    expect(files[crdFile]).toBe(routed.crds[0].text + "\n");
    const manifestFiles = Object.keys(files).filter((f) => f.startsWith("manifests/"));
    const shims = Object.keys(files).filter((f) => f.startsWith("templates/"));
    expect(manifestFiles).toHaveLength(2);
    expect(shims).toHaveLength(2);
    for (const doc of [...routed.main, ...routed.hooks]) {
      expect(manifestFiles.map((f) => files[f])).toContain(doc.text + "\n");
    }
    for (const shim of shims) {
      expect(files[shim]).toMatch(/^\{\{ \.Files\.Get "manifests\/[a-z0-9-]+\.yaml" \}\}\n$/);
    }
    expect(files["Chart.yaml"]).toContain("name: umb");
    expect(files["Chart.yaml"]).toContain("version: 0.1.0");

    // Result fields, complete.
    expect(result.pinned).toBe(true);
    expect(result.contentDigest).toBe(manifest.contentDigest);
    expect(result.inputDigest).toBe(manifest.inputDigest);
    expect(result.releaseName).toBe("web");
    expect(result.namespace).toBeNull();
    expect(result.revision).toBe(2);
    expect(result.chartVersion).toBe("0.1.0");
    expect(result.crdsApplied).toBe(1);
    expect(result.docsApplied).toBe(2);
    expect(result.hooksRun).toBe(1);
    expect(result.profileAssertion).toEqual({ matched: true });
    expect(result.release.recorded).toBe(true);
  });

  test("the ReleaseRecord is keyed by the content digest and carries the input digest alongside", async () => {
    const { manifest, root } = storeRender();
    helm.metadata = { name: "web", revision: 1, version: "0.1.0" };

    await helmInstall({ name: "web", contentDigest: manifest.contentDigest, renderStoreRoot: root, env: "prod" });

    expect(ledger.calls).toHaveLength(1);
    expect(ledger.calls[0].digest).toBe(manifest.contentDigest);
    expect(ledger.calls[0].inputDigest).toBe(manifest.inputDigest);
    expect(ledger.calls[0].env).toBe("prod");
    expect(ledger.calls[0].component).toBe("web");
  });

  test("the live #1244 assertion runs against the manifest's recorded profile, before the install", async () => {
    const { manifest, root } = storeRender();
    cluster.serverVersion = { major: "1", minor: "30", gitVersion: "v1.30.0" }; // diverges from recorded 1.33.6
    await expect(
      helmInstall({ name: "web", contentDigest: manifest.contentDigest, renderStoreRoot: root }),
    ).rejects.toThrow(/does not match the declared capability profile "k3d-local"/);
    expect(helm.calls.filter((c) => c.startsWith("helm"))).toHaveLength(0);
  });

  test("refuses a digest the store does not hold, before any exec", async () => {
    const { root } = storeRender();
    await expect(
      helmInstall({ name: "web", contentDigest: "sha256:" + "0".repeat(64), renderStoreRoot: root }),
    ).rejects.toThrow(PinnedRenderNotFoundError);
    expect(helm.calls).toHaveLength(0);
    expect(ledger.calls).toHaveLength(0);
  });

  test("verifies the stored bytes against the digest before any mutation — a corrupt entry refuses", async () => {
    const { manifest, root } = storeRender();
    const contentFile = join(root, manifest.contentDigest.replace("sha256:", "sha256-"), "content.yaml");
    appendFileSync(contentFile, "# tampered\n");
    await expect(
      helmInstall({ name: "web", contentDigest: manifest.contentDigest, renderStoreRoot: root }),
    ).rejects.toThrow(PinnedRenderIntegrityError);
    expect(helm.calls).toHaveLength(0);
  });

  test("refuses deploy-time render inputs alongside contentDigest, naming them", async () => {
    const { manifest, root } = storeRender();
    await expect(
      helmInstall({
        name: "web",
        chart: "./chart",
        set: { a: "1" },
        contentDigest: manifest.contentDigest,
        renderStoreRoot: root,
      }),
    ).rejects.toThrow(/render input\(s\) `chart`, `set`/);
    expect(helm.calls).toHaveLength(0);
  });

  test("refuses a release name the bytes were not rendered for", async () => {
    const { manifest, root } = storeRender();
    await expect(
      helmInstall({ name: "other", contentDigest: manifest.contentDigest, renderStoreRoot: root }),
    ).rejects.toThrow(PinnedInstallInputError);
    await expect(
      helmInstall({ name: "other", contentDigest: manifest.contentDigest, renderStoreRoot: root }),
    ).rejects.toThrow(/rendered for release "web"/);
    expect(helm.calls).toHaveLength(0);
  });

  test("refuses a declared profile that disagrees with the recorded one, offline, before any probe", async () => {
    const { manifest, root } = storeRender();
    await expect(
      helmInstall({
        name: "web",
        contentDigest: manifest.contentDigest,
        renderStoreRoot: root,
        capabilityProfile: { name: "prod", kubeVersion: "1.30.0" },
      }),
    ).rejects.toThrow(PinnedProfileMismatchError);
    expect(helm.calls).toHaveLength(0); // not even the kubectl probe ran
  });

  test("a matching declared profile composes with the live assertion and deploys", async () => {
    const { manifest, root } = storeRender();
    helm.metadata = { name: "web", revision: 3, version: "0.1.0" };
    const result = await helmInstall({
      name: "web",
      contentDigest: manifest.contentDigest,
      renderStoreRoot: root,
      capabilityProfile: { name: "k3d-local", kubeVersion: "1.33.6", apiVersions: ["apps/v1"] },
    });
    expect(result.pinned).toBe(true);
    expect(result.revision).toBe(3);
  });

  test("a metadata read failure after a successful install warns and leaves revision unset", async () => {
    const { manifest, root } = storeRender();
    helm.metadataFail = true;
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await helmInstall({ name: "web", contentDigest: manifest.contentDigest, renderStoreRoot: root });
    expect(result.revision).toBeUndefined();
    expect(result.chartVersion).toBe("0.1.0"); // falls back to the stored render's
    expect(result.release.recorded).toBe(true); // the deploy and its record still happened
    expect(warn.mock.calls.map((c) => String(c[0])).join("\n")).toContain("helm get metadata");
    warn.mockRestore();
  });

  test("the unpinned path is unchanged: same argv as before #1242, pinned: false, no store access", async () => {
    const result = await helmInstall({ name: "web", chart: "./chart" });
    expect(helm.calls).toEqual(["helm upgrade --install --wait web ./chart"]);
    expect(result.pinned).toBe(false);
    expect(result.contentDigest).toBeUndefined();
    expect(result.releaseName).toBe("web");
  });
});
