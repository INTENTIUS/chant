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
 *
 * The cluster has a random name and API port so parallel runs don't
 * collide, and is deleted in afterAll whatever happened. The kubelet's
 * disk-pressure eviction is turned down to 1% free: with its defaults
 * (evict under 15% free image storage) a Docker disk that is merely full-ish
 * evicts both pods and taints the node, which is what #2969 saw as "cannot
 * exec into a container in a completed pod". The APIs are read through the
 * API server's service proxy, which only reaches a ready endpoint, rather
 * than by exec into whichever pod `deploy/<name>` resolves to.
 */
import { execFileSync, execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
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

const CLUSTER = `chant-prom-e2e-${randomBytes(4).toString("hex")}`;
const srcDir = join(import.meta.dirname, "k3d-stack", "src");

/** Evict only when the node is truly out of disk. */
const EVICTION = [
  "--kubelet-arg=eviction-hard=imagefs.available<1%,nodefs.available<1%",
  "--kubelet-arg=eviction-minimum-reclaim=imagefs.available=1%,nodefs.available=1%",
];

function text(out: string | SerializerResult | undefined): string {
  if (out === undefined) throw new Error("no output");
  return typeof out === "string" ? out : out.primary;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

/** A free TCP port on 127.0.0.1, for the cluster's API server. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      srv.close(() => (addr && typeof addr === "object" ? resolve(addr.port) : reject(new Error("no port"))));
    });
  });
}

function deleteCluster(): void {
  try {
    execFileSync("k3d", ["cluster", "delete", CLUSTER], { stdio: "ignore" });
  } catch {
    // already gone, or never created
  }
}

describe.skipIf(missing !== undefined)(`k3d-stack runs on k3d${missing ? ` (skipped: ${missing})` : ""}`, () => {
  let dir: string | undefined;
  let env: NodeJS.ProcessEnv;

  const kubectl = (...args: string[]): string => execFileSync("kubectl", args, { env, encoding: "utf-8" });
  /** GET `path` on a Service's `http` port through the API server. */
  const get = (service: string, path: string): unknown =>
    JSON.parse(kubectl("get", "--raw", `/api/v1/namespaces/default/services/${service}:http/proxy${path}`));

  /** The pods and node conditions, for a timeout message that says why. */
  function clusterState(): string {
    try {
      const pods = kubectl("get", "pods", "-o", "wide");
      const taints = kubectl("get", "nodes", "-o", "jsonpath={.items[*].spec.taints}");
      return `\n${pods}node taints: ${taints || "none"}`;
    } catch (err) {
      return `\n(cluster state unavailable: ${String(err)})`;
    }
  }

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
    throw new Error(`timed out waiting for ${what}${last ? `: ${String(last)}` : ""}${clusterState()}`);
  }

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "chant-prom-e2e-"));
    const port = await freePort();
    try {
      execFileSync(
        "k3d",
        [
          "cluster",
          "create",
          CLUSTER,
          "--api-port",
          `127.0.0.1:${port}`,
          "--no-lb",
          "--wait",
          "--timeout",
          "180s",
          "--kubeconfig-update-default=false",
          "--kubeconfig-switch-context=false",
          // Neither is needed, and each pulls images.
          "--k3s-arg",
          "--disable=traefik@server:*",
          "--k3s-arg",
          "--disable=metrics-server@server:*",
          ...EVICTION.flatMap((a) => ["--k3s-arg", `${a}@server:*`]),
        ],
        { stdio: "inherit" },
      );
    } catch (err) {
      deleteCluster();
      throw err;
    }
    const kubeconfig = join(dir, "kubeconfig");
    writeFileSync(kubeconfig, execFileSync("k3d", ["kubeconfig", "get", CLUSTER], { encoding: "utf-8" }));
    env = { ...process.env, KUBECONFIG: kubeconfig };
  }, 300_000);

  afterAll(() => {
    deleteCluster();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }, 120_000);

  test(
    "Prometheus loads the built rules and Alertmanager receives the alert through the declared route",
    { timeout: 600_000 },
    async () => {
      const result = await build(srcDir, [k8sSerializer, prometheusSerializer]);
      expect(result.errors).toEqual([]);
      const manifests = join(dir!, "k8s.yaml");
      writeFileSync(manifests, text(result.outputs.get("k8s")));

      kubectl("apply", "-f", manifests);
      for (const deploy of ["prometheus", "alertmanager"]) {
        try {
          kubectl("rollout", "status", `deploy/${deploy}`, "--timeout=300s");
        } catch (err) {
          throw new Error(`${deploy} did not roll out: ${String(err)}${clusterState()}`);
        }
      }

      // Prometheus loaded the group the lexicon built.
      const expected = (load(text(result.outputs.get("prometheus"))) as { groups: Array<{ name: string; rules: unknown[] }> }).groups[0];
      const loaded = await eventually("the rule group to load", () => {
        const body = get("prometheus", "/api/v1/rules") as { data: { groups: Array<{ name: string; rules: unknown[] }> } };
        return body.data.groups.find((g) => g.name === expected.name);
      });
      expect(loaded.rules).toHaveLength(expected.rules.length);

      // Prometheus fired Watchdog and Alertmanager holds it under the heartbeat receiver.
      const alert = await eventually("Watchdog to reach Alertmanager", () => {
        const alerts = get("alertmanager", "/api/v2/alerts") as Array<{
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
