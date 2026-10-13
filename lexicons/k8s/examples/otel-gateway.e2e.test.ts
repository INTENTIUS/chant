/**
 * The otel-gateway example on a real cluster (#2898): build it, bring up a
 * two-node k3d cluster with the k3d lexicon's `k3dUp`, apply the manifests,
 * send traces to the agent's Service, and check that the gateway received
 * them, with every span of a trace on one gateway replica (the agents'
 * `loadbalancing` exporter routing by trace id through the headless Service,
 * using the Role the agent composite added).
 *
 * On demand, like the other runtime e2e runs: skipped, with the reason in
 * the test name, unless Docker, k3d and kubectl are all available. CI
 * installs no k3d, so it skips there. Takes a few minutes, most of it
 * pulling images.
 */
import { execFileSync, execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { build } from "@intentius/chant/build";
import { k8sSerializer } from "@intentius/chant-lexicon-k8s";
import { COLLECTOR_PIN } from "@intentius/chant-lexicon-otel";
import { k3dDown, k3dUp } from "@intentius/chant-lexicon-k3d/op/activities";

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

const CLUSTER = `chant-otel-gw-${process.pid}`;
const NS = "observability";
const SERVICE_NAME = "chant-gateway-e2e";
const TELEMETRYGEN = `ghcr.io/open-telemetry/opentelemetry-collector-contrib/telemetrygen:${COLLECTOR_PIN.version}`;
const srcDir = join(import.meta.dirname, "otel-gateway", "src");

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

describe.skipIf(missing !== undefined)(`otel-gateway runs on k3d${missing ? ` (skipped: ${missing})` : ""}`, () => {
  let dir: string;
  let env: NodeJS.ProcessEnv;

  const kubectl = (...args: string[]): string => execFileSync("kubectl", args, { env, encoding: "utf-8" });

  async function eventually<T>(what: string, probe: () => T | undefined, timeoutMs = 240_000): Promise<T> {
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
    throw new Error(`timed out waiting for ${what}${last ? `: ${String(last)}` : ""}`);
  }

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "chant-otel-gw-e2e-"));
    const { kubeconfigPath } = await k3dUp({ name: CLUSTER, agents: 1, timeout: "180s" });
    if (!kubeconfigPath) throw new Error("k3dUp returned no kubeconfig");
    env = { ...process.env, KUBECONFIG: kubeconfigPath };
  }, 300_000);

  afterAll(async () => {
    try {
      await k3dDown({ name: CLUSTER });
    } catch {
      // already gone
    }
    if (dir) rmSync(dir, { recursive: true, force: true });
  }, 120_000);

  test("the gateway receives the agent's spans, each trace on one replica", { timeout: 900_000 }, async () => {
    const result = await build(srcDir, [k8sSerializer]);
    expect(result.errors).toEqual([]);
    const out = result.outputs.get("k8s")!;
    const manifests = join(dir, "k8s.yaml");
    writeFileSync(manifests, typeof out === "string" ? out : out.primary);

    kubectl("apply", "-f", manifests);
    kubectl("-n", NS, "rollout", "status", "deploy/otel-gateway", "--timeout=420s");
    kubectl("-n", NS, "rollout", "status", "ds/otel-agent", "--timeout=420s");

    // Error traces, so the gateway's tail sampling keeps every one. The agent
    // Service keeps traffic on the sender's node, and there is an agent on
    // every node.
    kubectl(
      "-n", NS, "run", "telemetrygen", "--restart=Never", `--image=${TELEMETRYGEN}`, "--",
      "traces",
      `--otlp-endpoint=otel-agent.${NS}.svc:4317`,
      "--otlp-insecure",
      "--traces=20",
      "--child-spans=2",
      "--status-code=Error",
      `--service=${SERVICE_NAME}`,
    );

    const pods = kubectl("-n", NS, "get", "pods", "-l", "app.kubernetes.io/name=otel-gateway", "-o", "name")
      .trim()
      .split("\n")
      .filter(Boolean);
    expect(pods).toHaveLength(2);

    // Trace ids each replica printed, once all 20 traces have arrived.
    const byPod = await eventually("the gateway to print all 20 traces", () => {
      const seen = pods.map((pod) => {
        const logs = kubectl("-n", NS, "logs", pod);
        if (!logs.includes(SERVICE_NAME)) return new Set<string>();
        return new Set([...logs.matchAll(/Trace ID\s*:\s*([0-9a-f]{32})/g)].map((m) => m[1]));
      });
      const total = new Set(seen.flatMap((s) => [...s]));
      return total.size >= 20 ? seen : undefined;
    });

    // Routing by trace id: both replicas got traces, and no trace reached both.
    const [a, b] = byPod;
    console.log(`gateway replicas received ${a.size} and ${b.size} traces`);
    expect(a.size).toBeGreaterThan(0);
    expect(b.size).toBeGreaterThan(0);
    expect([...a].filter((id) => b.has(id))).toEqual([]);
  });
});
