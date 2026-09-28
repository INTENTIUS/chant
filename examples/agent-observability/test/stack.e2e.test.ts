/**
 * The agent-observability example on a real cluster (#2904): build it, check
 * the rendered configs with the real tools, bring up the declared k3d
 * cluster with the k3d lexicon's `k3dUp`, apply the manifests, and let the
 * demo agent send spans. Then check, against the running backends:
 *
 * - traces reach Tempo, sampled: every failed and every slow run is there,
 *   some ordinary runs are not, and no stored span carries prompt content;
 * - the RED span metrics and the GenAI `genai_*` metrics reach Prometheus,
 *   counting every run, not only the sampled ones;
 * - the SLO's recording rules evaluate, its page alert fires and reaches
 *   Alertmanager's `oncall` receiver, and the ticket alert is inhibited;
 * - the agent's logs reach Loki;
 * - Grafana serves the provisioned datasources and dashboards.
 *
 * The real tools run from the images the stack uses: `promtool check rules`,
 * `amtool check-config`, and `otelcol validate` on both collector configs.
 *
 * On demand, like the other runtime e2e runs: skipped, with the reason in the
 * test name, unless Docker, k3d and kubectl are all available. CI installs no
 * k3d, so it skips there. The demo agent's image is built on the host and
 * imported; the nodes pull the rest. Set CHANT_KEEP_CLUSTER=1 to leave the
 * cluster up afterwards.
 *
 *   npx vitest run --project e2e examples/agent-observability
 */
import { execFileSync, execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { COLLECTOR_IMAGE, genAiMetrics } from "@intentius/chant-lexicon-otel";
import { sloMetrics } from "@intentius/chant-lexicon-prometheus";
import { k3dDown, k3dUp } from "@intentius/chant-lexicon-k3d/op/activities";
import { agentRuns } from "../src/slo";
import { ALERTMANAGER_IMAGE, PROMETHEUS_IMAGE } from "../src/prometheus";
import { DEMO_IMAGE, DEMO_NAMESPACE } from "../src/demo";
import { NAMESPACE } from "../src/namespace";
import { buildExample, exampleDir, images, type Built } from "./built";

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

const CLUSTER = `chant-agent-obs-${process.pid}`;
const KEEP = process.env.CHANT_KEEP_CLUSTER === "1";

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

const started = Date.now();
const timings: Array<[string, number]> = [];
let mark = Date.now();
function lap(what: string): void {
  const now = Date.now();
  timings.push([what, Math.round((now - mark) / 1000)]);
  console.log(`[agent-observability e2e] ${what}: ${Math.round((now - mark) / 1000)}s (total ${Math.round((now - started) / 1000)}s)`);
  mark = now;
}

describe.skipIf(missing !== undefined)(`agent-observability runs on k3d${missing ? ` (skipped: ${missing})` : ""}`, () => {
  let dir: string;
  let env: NodeJS.ProcessEnv;
  let built: Built;

  const kubectl = (...args: string[]): string => execFileSync("kubectl", args, { env, encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 });

  /** GET through the API server's service proxy, so the test needs no port-forward. */
  function proxied(service: string, path: string, namespace = NAMESPACE): string {
    return kubectl("get", "--raw", `/api/v1/namespaces/${namespace}/services/${service}:http/proxy${path}`);
  }
  const getJson = <T>(service: string, path: string): T => JSON.parse(proxied(service, path)) as T;

  function promQuery(expr: string): Array<{ metric: Record<string, string>; value: [number, string] }> {
    const body = getJson<{ data: { result: Array<{ metric: Record<string, string>; value: [number, string] }> } }>(
      "prometheus",
      `/api/v1/query?query=${encodeURIComponent(expr)}`,
    );
    return body.data.result;
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
    throw new Error(`timed out waiting for ${what}${last ? `: ${String(last)}` : ""}`);
  }

  /** Run a tool from an image over a file in the build directory. */
  function tool(image: string, entrypoint: string | undefined, args: string[]): { ok: boolean; output: string } {
    try {
      const output = execFileSync(
        "docker",
        ["run", "--rm", "-v", `${dir}:/cfg:ro`, ...(entrypoint ? ["--entrypoint", entrypoint] : []), image, ...args],
        { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
      );
      return { ok: true, output };
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string };
      return { ok: false, output: `${e.stdout ?? ""}${e.stderr ?? ""}` };
    }
  }

  function diagnostics(): void {
    try {
      console.log(kubectl("get", "pods", "-A", "-o", "wide"));
      for (const deploy of ["otel-gateway", "tempo", "loki", "prometheus", "grafana"]) {
        console.log(`--- ${deploy}\n${kubectl("-n", NAMESPACE, "logs", `deploy/${deploy}`, "--tail=40")}`);
      }
      console.log(`--- otel-agent\n${kubectl("-n", NAMESPACE, "logs", "ds/otel-agent", "--tail=40")}`);
      console.log(`--- support-agent\n${kubectl("-n", DEMO_NAMESPACE, "logs", "deploy/support-agent", "--tail=20")}`);
    } catch (err) {
      console.log(`diagnostics failed: ${String(err)}`);
    }
  }

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "chant-agent-obs-e2e-"));
    built = await buildExample();
    expect(built.errors).toEqual([]);
    writeFileSync(join(dir, "k3d.yaml"), built.k3dYaml);
    writeFileSync(join(dir, "k8s.yaml"), built.k8sYaml);
    writeFileSync(join(dir, "rules.yml"), built.rulesYaml);
    writeFileSync(join(dir, "alertmanager.yml"), built.alertmanagerYaml);
    writeFileSync(join(dir, "agent.yaml"), built.agentConfigYaml);
    writeFileSync(join(dir, "gateway.yaml"), built.gatewayConfigYaml);
    lap("build");

    // The demo agent's image exists only on this host, so it is built here
    // and imported into the cluster; the nodes pull every other image from
    // its registry. Importing all of them would hold a second copy of each
    // on every node, which a laptop's Docker disk may not have room for.
    execFileSync("docker", ["build", "-q", "-t", DEMO_IMAGE, join(exampleDir, "app")], { stdio: "ignore" });
    expect(images(built.manifests)).toContain(DEMO_IMAGE);
    lap("demo image built");

    const { kubeconfigPath } = await k3dUp({ name: CLUSTER, configFile: join(dir, "k3d.yaml"), timeout: "300s" });
    if (!kubeconfigPath) throw new Error("k3dUp returned no kubeconfig");
    env = { ...process.env, KUBECONFIG: kubeconfigPath };
    lap("k3d cluster up");

    execFileSync("k3d", ["image", "import", "-c", CLUSTER, DEMO_IMAGE], { stdio: "ignore" });
    lap("demo image imported");
  }, 1_200_000);

  afterAll(async () => {
    if (!KEEP) {
      try {
        await k3dDown({ name: CLUSTER });
      } catch {
        // already gone
      }
    } else {
      console.log(`[agent-observability e2e] cluster ${CLUSTER} left up (CHANT_KEEP_CLUSTER=1)`);
    }
    if (dir) rmSync(dir, { recursive: true, force: true });
    console.log(`[agent-observability e2e] timings: ${timings.map(([w, s]) => `${w} ${s}s`).join(", ")}`);
  }, 300_000);

  test("promtool, amtool and otelcol accept the rendered configs", { timeout: 300_000 }, () => {
    // The agent's config is validated inside the cluster (below): its
    // loadbalancing exporter's k8s resolver builds a Kubernetes client as
    // soon as the pipeline is built, and a container on the host has no API
    // server to reach.
    const rules = tool(PROMETHEUS_IMAGE, "promtool", ["check", "rules", "/cfg/rules.yml"]);
    expect(rules.ok, rules.output).toBe(true);
    const am = tool(ALERTMANAGER_IMAGE, "amtool", ["check-config", "/cfg/alertmanager.yml"]);
    expect(am.ok, am.output).toBe(true);
    const gateway = tool(COLLECTOR_IMAGE, undefined, ["validate", "--config=/cfg/gateway.yaml"]);
    expect(gateway.ok, gateway.output).toBe(true);
    lap("promtool, amtool, otelcol validate (gateway)");
  });

  test("the stack comes up, and every signal lands where the declarations say", { timeout: 1_800_000 }, async () => {
    try {
      kubectl("apply", "-f", join(dir, "k8s.yaml"));
      for (const workload of ["deploy/otel-gateway", "ds/otel-agent", "deploy/tempo", "deploy/loki", "deploy/prometheus", "deploy/alertmanager", "deploy/grafana"]) {
        kubectl("-n", NAMESPACE, "rollout", "status", workload, "--timeout=600s");
      }
      // The demo agent started with everything else; restart it now that the
      // collectors and backends are ready, so none of its runs are lost to a
      // gateway that was still starting.
      const firstPods = kubectl("-n", DEMO_NAMESPACE, "get", "pods", "-l", "app.kubernetes.io/name=support-agent", "-o", "name")
        .split("\n")
        .filter(Boolean);
      kubectl("-n", DEMO_NAMESPACE, "rollout", "restart", "deploy/support-agent");
      kubectl("-n", DEMO_NAMESPACE, "rollout", "status", "deploy/support-agent", "--timeout=300s");
      // Its logs are read below; wait until only the new pod is left to read them from.
      if (firstPods.length > 0) kubectl("-n", DEMO_NAMESPACE, "wait", "--for=delete", ...firstPods, "--timeout=120s");
      lap("stack rolled out");

      // `otelcol validate` on the agent's config, as the agent's own
      // ServiceAccount, from the ConfigMap the DaemonSet mounts.
      const validatePod = {
        apiVersion: "v1",
        kind: "Pod",
        metadata: { name: "otelcol-validate-agent", namespace: NAMESPACE },
        spec: {
          serviceAccountName: "otel-agent-sa",
          restartPolicy: "Never",
          containers: [
            {
              name: "validate",
              image: COLLECTOR_IMAGE,
              args: ["validate", "--config=/conf/config.yaml"],
              volumeMounts: [{ name: "config", mountPath: "/conf", readOnly: true }],
            },
          ],
          volumes: [{ name: "config", configMap: { name: "otel-agent-config" } }],
        },
      };
      writeFileSync(join(dir, "validate-agent.json"), JSON.stringify(validatePod));
      kubectl("apply", "-f", join(dir, "validate-agent.json"));
      const phase = await eventually("otelcol validate on the agent config to finish", () => {
        const p = kubectl("-n", NAMESPACE, "get", "pod", "otelcol-validate-agent", "-o", "jsonpath={.status.phase}");
        return p === "Succeeded" || p === "Failed" ? p : undefined;
      }, 180_000);
      expect(phase, kubectl("-n", NAMESPACE, "logs", "otelcol-validate-agent")).toBe("Succeeded");
      lap("otelcol validate (agent, in the cluster)");

      // ── Metrics: every run counted, before sampling ────────────────
      const red = await eventually("RED span metrics in Prometheus", () => {
        const r = promQuery('sum(traces_span_metrics_calls_total{service_name="support-agent",span_name="invoke_agent support"})');
        return r.length > 0 && Number(r[0].value[1]) >= 20 ? r : undefined;
      });
      lap("RED metrics in Prometheus");
      const genai = genAiMetrics();
      const operations = await eventually("genai_* metrics per operation", () => {
        const r = promQuery(`sum by (gen_ai_operation_name) (${genai.calls.prometheus})`);
        const ops = r.map((s) => s.metric.gen_ai_operation_name).sort();
        return ops.length === 3 ? ops : undefined;
      });
      expect(operations).toEqual(["chat", "execute_tool", "invoke_agent"]);
      const tokens = promQuery(`sum by (gen_ai_request_model) (${genai.inputTokens.prometheus})`);
      expect(tokens.map((s) => s.metric.gen_ai_request_model)).toEqual(["demo-small"]);
      expect(Number(tokens[0].value[1])).toBeGreaterThan(0);
      expect(promQuery(`sum(${genai.duration.prometheus}_count)`).length).toBe(1);
      const failedTools = promQuery(`sum(${genai.calls.prometheus}{gen_ai_tool_name="lookup_order",error_type="timeout"})`);
      expect(Number(failedTools[0]?.value[1] ?? 0)).toBeGreaterThan(0);
      lap("genai metrics in Prometheus");

      // ── Traces: sampled, and without content ───────────────────────
      // The demo agent's own log says which run was which. Settle past the
      // gateway's 5s decision wait and 5s batch before reading Tempo.
      const readRuns = () =>
        kubectl("-n", DEMO_NAMESPACE, "logs", "deploy/support-agent")
          .split("\n")
          .map((line) => /^run (\d+): trace ([0-9a-f]{32})( \(failed\))?/.exec(line))
          .filter((m): m is RegExpExecArray => m !== null)
          .map((m) => ({ n: Number(m[1]), traceId: m[2], failed: m[3] !== undefined }));
      await eventually("50 runs of the demo agent", () => (readRuns().length >= 50 ? true : undefined));
      const runs = readRuns();
      // The last ten runs may still be inside the gateway's decision wait.
      const settled = runs.slice(0, -10);
      expect(settled.length).toBeGreaterThanOrEqual(30);
      // Tempo answers an unknown trace id with a 404 or with an empty trace, depending on the path it took.
      const inTempo = (traceId: string): boolean => {
        try {
          const body = JSON.parse(proxied("tempo", `/api/v2/traces/${traceId}`)) as { trace?: { resourceSpans?: unknown[] } };
          return (body.trace?.resourceSpans?.length ?? 0) > 0;
        } catch {
          return false;
        }
      };
      const failed = settled.filter((r) => r.failed);
      const slow = settled.filter((r) => !r.failed && r.n % 7 === 0);
      const ordinary = settled.filter((r) => !r.failed && r.n % 7 !== 0);
      expect(failed.map((r) => [r.n, inTempo(r.traceId)])).toEqual(failed.map((r) => [r.n, true]));
      expect(slow.map((r) => [r.n, inTempo(r.traceId)])).toEqual(slow.map((r) => [r.n, true]));
      const keptOrdinary = ordinary.filter((r) => inTempo(r.traceId)).length;
      console.log(
        `[agent-observability e2e] Tempo kept ${failed.length}/${failed.length} failed, ${slow.length}/${slow.length} slow, ` +
          `${keptOrdinary}/${ordinary.length} ordinary runs; Prometheus counted ${red[0].value[1]} runs`,
      );
      expect(keptOrdinary).toBeLessThan(ordinary.length);

      const trace = proxied("tempo", `/api/v2/traces/${failed[0].traceId}`);
      for (const name of ["invoke_agent support", "chat demo-small", "execute_tool lookup_order"]) expect(trace).toContain(name);
      expect(trace).toContain("gen_ai.usage.input_tokens");
      expect(trace).not.toContain("gen_ai.input.messages");
      expect(trace).not.toContain("Where is order");
      lap("traces in Tempo");

      // ── The SLO ────────────────────────────────────────────────────
      const slo = sloMetrics(agentRuns);
      const ratio = await eventually("the SLO's 5m error ratio", () => {
        const r = promQuery(`${slo.errorRatio["5m"]}${slo.selector}`);
        return r.length > 0 ? Number(r[0].value[1]) : undefined;
      });
      expect(ratio).toBeGreaterThan(0.1);
      expect(ratio).toBeLessThan(0.3);
      const group = getJson<{ data: { groups: Array<{ name: string; rules: Array<{ name: string; health: string }> }> } }>(
        "prometheus",
        "/api/v1/rules",
      ).data.groups.find((g) => g.name === slo.group);
      expect(group?.rules.map((r) => r.health)).toEqual(group?.rules.map(() => "ok"));
      const page = await eventually(
        "the page alert in Alertmanager",
        () => {
          const alerts = getJson<Array<{ labels: Record<string, string>; receivers: Array<{ name: string }>; status: { inhibitedBy: string[] } }>>(
            "alertmanager",
            "/api/v2/alerts",
          );
          const p = alerts.find((a) => a.labels.alertname === slo.alertName && a.labels.severity === "page");
          const t = alerts.find((a) => a.labels.alertname === slo.alertName && a.labels.severity === "ticket");
          return p && t ? { p, t } : undefined;
        },
        420_000,
      );
      expect(page.p.receivers.map((r) => r.name)).toEqual(["oncall"]);
      expect(page.t.receivers.map((r) => r.name)).toEqual(["tickets"]);
      expect(page.t.status.inhibitedBy.length).toBeGreaterThan(0);
      lap("SLO rules and alert routing");

      // ── Logs ───────────────────────────────────────────────────────
      const streams = await eventually("the agent's logs in Loki", () => {
        const q = encodeURIComponent('{service_name="support-agent"}');
        const body = getJson<{ data: { result: Array<{ values: unknown[] }> } }>("loki", `/loki/api/v1/query_range?query=${q}&limit=20&since=1h`);
        return body.data.result.length > 0 ? body.data.result : undefined;
      });
      expect(streams[0].values.length).toBeGreaterThan(0);
      lap("logs in Loki");

      // ── Grafana ────────────────────────────────────────────────────
      const settings = getJson<{ datasources: Record<string, { type: string; uid: string }> }>("grafana", "/api/frontend/settings");
      for (const ds of built.grafanaIndex.datasources) {
        expect(settings.datasources[ds.name], ds.name).toEqual(expect.objectContaining({ type: ds.type, uid: ds.uid }));
      }
      const listed = await eventually("the provisioned dashboards", () => {
        const found = getJson<Array<{ uid: string }>>("grafana", "/api/search?type=dash-db").map((d) => d.uid);
        return built.grafanaIndex.dashboards.every((d) => found.includes(d.uid)) ? found : undefined;
      });
      expect(listed.length).toBeGreaterThanOrEqual(built.grafanaIndex.dashboards.length);
      for (const d of built.grafanaIndex.dashboards) {
        const served = getJson<{ dashboard: { title: string; panels: unknown[] } }>("grafana", `/api/dashboards/uid/${d.uid}`);
        const file = JSON.parse(built.grafanaFiles[d.file]) as { panels: unknown[] };
        expect(served.dashboard.title).toBe(d.title);
        expect(served.dashboard.panels.length).toBe(file.panels.length);
      }
      lap("Grafana datasources and dashboards");
    } catch (err) {
      diagnostics();
      throw err;
    }
  });
});
