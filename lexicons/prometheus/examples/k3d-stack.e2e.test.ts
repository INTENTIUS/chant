/**
 * The k3d-stack example on a real cluster (#2901): build it, bring up a k3d
 * cluster, apply the k8s output, and check that Prometheus loaded the rule
 * file this lexicon wrote, fired the always-on `Watchdog` alert, and that
 * Alertmanager received it through the declared route.
 *
 * On demand, like the other runtime e2e runs: skipped, with the reason in
 * the test name, unless Docker, k3d and kubectl are all available. CI
 * installs none of k3d, so it skips there. Takes a few minutes, most of it
 * pulling images.
 */
import { execFileSync, execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { load } from "js-yaml";
import { build } from "@intentius/chant/build";
import type { SerializerResult } from "@intentius/chant/serializer";
import { k8sSerializer } from "@intentius/chant-lexicon-k8s";
import { prometheusSerializer } from "@intentius/chant-lexicon-prometheus";

function available(cmd: string): boolean {
  try {
    execSync(cmd, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const missing = [
  ["Docker is not running", "docker info"],
  ["k3d is not installed", "k3d version"],
  ["kubectl is not installed", "kubectl version --client"],
].find(([, cmd]) => !available(cmd))?.[0];

const CLUSTER = `chant-prom-e2e-${process.pid}`;
const srcDir = join(import.meta.dirname, "k3d-stack", "src");

function text(out: string | SerializerResult | undefined): string {
  if (out === undefined) throw new Error("no output");
  return typeof out === "string" ? out : out.primary;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

describe.skipIf(missing !== undefined)(`k3d-stack runs on k3d${missing ? ` (skipped: ${missing})` : ""}`, () => {
  let dir: string;
  let env: NodeJS.ProcessEnv;

  const kubectl = (...args: string[]): string => execFileSync("kubectl", args, { env, encoding: "utf-8" });
  const get = (deploy: string, url: string): unknown => JSON.parse(kubectl("exec", `deploy/${deploy}`, "--", "wget", "-qO-", url));

  async function eventually<T>(what: string, probe: () => T | undefined, timeoutMs = 180_000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    let last: unknown;
    while (Date.now() < deadline) {
      try {
        const v = probe();
        if (v !== undefined) return v;
      } catch (err) {
        last = err;
      }
      await sleep(3_000);
    }
    throw new Error(`timed out waiting for ${what}${last ? `: ${String(last)}` : ""}`);
  }

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "chant-prom-e2e-"));
    execFileSync("k3d", ["cluster", "create", CLUSTER, "--wait", "--timeout", "180s", "--no-lb", "--kubeconfig-update-default=false"], {
      stdio: "inherit",
    });
    const kubeconfig = join(dir, "kubeconfig");
    writeFileSync(kubeconfig, execFileSync("k3d", ["kubeconfig", "get", CLUSTER], { encoding: "utf-8" }));
    env = { ...process.env, KUBECONFIG: kubeconfig };
  }, 300_000);

  afterAll(() => {
    try {
      execFileSync("k3d", ["cluster", "delete", CLUSTER], { stdio: "ignore" });
    } catch {
      // already gone
    }
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test(
    "Prometheus loads the built rules and Alertmanager receives the alert through the declared route",
    { timeout: 600_000 },
    async () => {
      const result = await build(srcDir, [k8sSerializer, prometheusSerializer]);
      expect(result.errors).toEqual([]);
      const manifests = join(dir, "k8s.yaml");
      writeFileSync(manifests, text(result.outputs.get("k8s")));

      kubectl("apply", "-f", manifests);
      kubectl("rollout", "status", "deploy/prometheus", "--timeout=300s");
      kubectl("rollout", "status", "deploy/alertmanager", "--timeout=300s");

      // Prometheus loaded the group the lexicon built.
      const expected = (load(text(result.outputs.get("prometheus"))) as { groups: Array<{ name: string; rules: unknown[] }> }).groups[0];
      const loaded = await eventually("the rule group to load", () => {
        const body = get("prometheus", "http://localhost:9090/api/v1/rules") as { data: { groups: Array<{ name: string; rules: unknown[] }> } };
        return body.data.groups.find((g) => g.name === expected.name);
      });
      expect(loaded.rules).toHaveLength(expected.rules.length);

      // Prometheus fired Watchdog and Alertmanager holds it under the heartbeat receiver.
      const alert = await eventually("Watchdog to reach Alertmanager", () => {
        const alerts = get("alertmanager", "http://localhost:9093/api/v2/alerts") as Array<{
          labels: Record<string, string>;
          receivers: Array<{ name: string }>;
        }>;
        return alerts.find((a) => a.labels.alertname === "Watchdog");
      });
      expect(alert.labels.severity).toBe("info");
      expect(alert.receivers.map((r) => r.name)).toEqual(["heartbeat"]);
    },
  );
});
