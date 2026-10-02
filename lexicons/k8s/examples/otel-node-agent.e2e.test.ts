/**
 * The otel-node-agent example on a real cluster (#3103): build it, bring up
 * a one-node k3d cluster, apply the manifests, and check that the agent,
 * as OtelCollector deploys the otel lexicon's NodeAgent with nothing added
 * by hand, reads its node:
 *
 * - a log line a pod writes comes back from `filelog` over /var/log/pods,
 *   with the pod's name from `k8sattributes` filtered by K8S_NODE_NAME (the
 *   read-only mount, group 0 on the root-owned file, and the variable);
 * - `hostmetrics` reports system metrics from the host root at /hostfs;
 * - `kubeletstats` reports node and pod metrics from the kubelet it reaches
 *   at ${env:K8S_NODE_NAME} with `nodes/stats`.
 *
 * Everything goes to the debug exporter, so the checks read `kubectl logs`.
 *
 * On demand, like the other runtime e2e runs: skipped, with the reason in
 * the test name, unless Docker, k3d and kubectl are all available. The
 * cluster has a random name and API port and is deleted in afterAll. The
 * kubelet's disk-pressure eviction is turned down to 1% free, as in the
 * prometheus lexicon's k3d-stack e2e, so a full-ish Docker disk doesn't
 * evict the pods.
 */
import { execFileSync, execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { build } from "@intentius/chant/build";
import { k8sSerializer } from "@intentius/chant-lexicon-k8s";

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

const CLUSTER = `chant-otel-node-${randomBytes(4).toString("hex")}`;
const NS = "observability";
const MARKER = `chant-node-agent-e2e-${randomBytes(4).toString("hex")}`;
const srcDir = join(import.meta.dirname, "otel-node-agent", "src");

/** Evict only when the node is truly out of disk. */
const EVICTION = [
  "--kubelet-arg=eviction-hard=imagefs.available<1%,nodefs.available<1%",
  "--kubelet-arg=eviction-minimum-reclaim=imagefs.available=1%,nodefs.available=1%",
];

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

describe.skipIf(missing !== undefined)(`otel-node-agent runs on k3d${missing ? ` (skipped: ${missing})` : ""}`, () => {
  let dir: string | undefined;
  let env: NodeJS.ProcessEnv;

  const kubectl = (...args: string[]): string =>
    execFileSync("kubectl", args, { env, encoding: "utf-8", maxBuffer: 256 * 1024 * 1024 });

  function clusterState(): string {
    try {
      const pods = kubectl("get", "pods", "-A", "-o", "wide");
      const taints = kubectl("get", "nodes", "-o", "jsonpath={.items[*].spec.taints}");
      const agent = kubectl("-n", NS, "logs", "ds/otel-collector", "--tail=40");
      return `\n${pods}node taints: ${taints || "none"}\nagent log tail:\n${agent}`;
    } catch (err) {
      return `\n(cluster state unavailable: ${String(err)})`;
    }
  }

  async function eventually<T>(what: string, probe: () => T | undefined, timeoutMs = 300_000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    let last: unknown;
    while (Date.now() < deadline) {
      try {
        const v = probe();
        if (v !== undefined) return v;
      } catch (err) {
        last = err;
      }
      await sleep(5_000);
    }
    throw new Error(`timed out waiting for ${what}${last ? `: ${String(last)}` : ""}${clusterState()}`);
  }

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "chant-otel-node-e2e-"));
    const port = await freePort();
    try {
      execFileSync(
        "k3d",
        [
          "cluster", "create", CLUSTER,
          "--api-port", `127.0.0.1:${port}`,
          "--no-lb",
          "--wait",
          "--timeout", "180s",
          "--kubeconfig-update-default=false",
          "--kubeconfig-switch-context=false",
          "--k3s-arg", "--disable=traefik@server:*",
          "--k3s-arg", "--disable=metrics-server@server:*",
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

  test("the agent reads its node's logs, host metrics and kubelet stats", { timeout: 900_000 }, async () => {
    const result = await build(srcDir, [k8sSerializer]);
    expect(result.errors).toEqual([]);
    const out = result.outputs.get("k8s")!;
    const manifests = join(dir!, "k8s.yaml");
    writeFileSync(manifests, typeof out === "string" ? out : out.primary);

    kubectl("create", "namespace", NS);
    kubectl("apply", "-f", manifests);
    kubectl("-n", NS, "rollout", "status", "ds/otel-collector", "--timeout=420s");

    kubectl(
      "run", "logger", "--restart=Never", "--image=busybox:1.36",
      "--", "sh", "-c", `while true; do echo ${MARKER}; sleep 2; done`,
    );
    kubectl("wait", "--for=condition=Ready", "pod/logger", "--timeout=180s");

    // How the runtime wrote the log file the agent reads, for the record.
    try {
      const mode = execFileSync(
        "docker",
        ["exec", `k3d-${CLUSTER}-server-0`, "sh", "-c", "stat -c '%a %u:%g %n' /var/log/pods/default_logger_*/logger/*.log"],
        { encoding: "utf-8" },
      );
      console.log(`logger's log file on the node: ${mode.trim()}`);
    } catch (err) {
      console.log(`could not stat the log file on the node: ${String(err)}`);
    }

    const logs = (): string => kubectl("-n", NS, "logs", "ds/otel-collector");

    // filelog over the mount, readable through group 0, with the pod's
    // metadata from k8sattributes filtered to this node.
    const resource = await eventually("the agent to print the logger's line with its pod name", () => {
      const chunks = logs().split(/ResourceLog #\d+/);
      return chunks.find((c) => c.includes(MARKER) && c.includes("k8s.pod.name: Str(logger)"));
    });
    expect(resource).toContain("k8s.cluster.name: Str(example)");
    expect(resource).toContain("log.file.path: Str(/var/log/pods/default_logger_");

    // hostmetrics from /hostfs, and kubeletstats through nodes/stats.
    const all = await eventually("host and kubelet metrics", () => {
      const text = logs();
      return /-> Name: system\.(cpu|memory)\./.test(text) && /-> Name: k8s\.(node|pod)\./.test(text) ? text : undefined;
    });
    expect(all).not.toMatch(/permission denied[^\n]*\/var\/log\/pods/i);
    expect(all).not.toMatch(/kubeletstats.*(Forbidden|no such host)/);
  });
});
