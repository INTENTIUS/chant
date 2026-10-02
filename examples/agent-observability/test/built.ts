/**
 * The example built in-process, the way `npm run build` builds it, and the
 * pieces the tests read out of it: the manifests, the two collector configs
 * from their ConfigMaps, the rule file and alertmanager.yml, and the Grafana
 * files.
 */
import { join } from "node:path";
import { loadAll } from "js-yaml";
import { build } from "@intentius/chant/build";
import type { SerializerResult } from "@intentius/chant/serializer";
import { k3dSerializer } from "@intentius/chant-lexicon-k3d";
import { k8sSerializer } from "@intentius/chant-lexicon-k8s";
import { prometheusSerializer, ALERTMANAGER_FILE } from "@intentius/chant-lexicon-prometheus";
import { grafanaSerializer } from "@intentius/chant-lexicon-grafana";
import type { CollectorConfig } from "@intentius/chant-lexicon-otel";

export const exampleDir = join(import.meta.dirname, "..");
export const srcDir = join(exampleDir, "src");

export interface Manifest {
  apiVersion: string;
  kind: string;
  metadata: { name: string; namespace?: string; labels?: Record<string, string>; annotations?: Record<string, string> };
  spec?: Record<string, any>;
  data?: Record<string, string>;
}

/** A collector config as the tests read it: with its service section and pipelines. */
export type Collector = CollectorConfig & {
  service: { pipelines: Record<string, { receivers: string[]; processors?: string[]; exporters: string[] }> };
};

export interface Built {
  /** Each lexicon's output text: the primary file. */
  k3dYaml: string;
  k8sYaml: string;
  rulesYaml: string;
  alertmanagerYaml: string;
  /** The grafana build's files by path, and its index. */
  grafanaFiles: Record<string, string>;
  grafanaIndex: { dashboards: Array<{ uid: string; title: string; file: string }>; datasources: Array<{ name: string; type: string; uid: string }> };
  manifests: Manifest[];
  /** The collector config each ConfigMap carries, parsed. */
  agentConfig: Collector;
  gatewayConfig: Collector;
  agentConfigYaml: string;
  gatewayConfigYaml: string;
  errors: unknown[];
}

function primary(out: string | SerializerResult | undefined): string {
  if (out === undefined) return "";
  return typeof out === "string" ? out : out.primary;
}

export function find(manifests: Manifest[], kind: string, name: string): Manifest {
  const m = manifests.find((d) => d.kind === kind && d.metadata.name === name);
  if (!m) throw new Error(`no ${kind} ${name} in the build`);
  return m;
}

/** Every container image the manifests run. */
export function images(manifests: Manifest[]): string[] {
  const out = new Set<string>();
  for (const m of manifests) {
    const pod = m.kind === "Deployment" || m.kind === "DaemonSet" ? m.spec?.template?.spec : undefined;
    for (const c of [...(pod?.initContainers ?? []), ...(pod?.containers ?? [])]) out.add(c.image as string);
  }
  return [...out].sort();
}

export async function buildExample(): Promise<Built> {
  const result = await build(srcDir, [k3dSerializer, k8sSerializer, prometheusSerializer, grafanaSerializer]);
  const k8sYaml = primary(result.outputs.get("k8s"));
  const manifests = (loadAll(k8sYaml) as Manifest[]).filter((d) => d && typeof d === "object");
  const prom = result.outputs.get("prometheus") as SerializerResult;
  const grafana = result.outputs.get("grafana") as SerializerResult;
  const agentConfigYaml = find(manifests, "ConfigMap", "otel-agent-config").data!["config.yaml"];
  const gatewayConfigYaml = find(manifests, "ConfigMap", "otel-gateway-config").data!["config.yaml"];
  return {
    k3dYaml: primary(result.outputs.get("k3d")),
    k8sYaml,
    rulesYaml: prom.primary,
    alertmanagerYaml: prom.files?.[ALERTMANAGER_FILE] ?? "",
    grafanaFiles: grafana.files ?? {},
    grafanaIndex: JSON.parse(grafana.primary),
    manifests,
    agentConfig: loadAll(agentConfigYaml)[0] as Collector,
    gatewayConfig: loadAll(gatewayConfigYaml)[0] as Collector,
    agentConfigYaml,
    gatewayConfigYaml,
    errors: result.errors,
  };
}
