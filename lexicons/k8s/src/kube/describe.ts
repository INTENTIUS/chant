/**
 * `chant kube describe` (chant #1079) — a generic, multi-section human view:
 * identity, chant's own verdict + provenance (when inside a project), a
 * pretty-printed spec/status, and the object's Events (reusing `./events.ts`'s
 * `listEvents`/`filterInvolved`, the same machinery `chant kube events`
 * itself uses — one implementation, not two). This is not kubectl's
 * per-kind template set (`OldReplicaSets`/`NewReplicaSet` for a Deployment,
 * per-container detail for a Pod, and so on for every built-in kind) — a
 * generic describe covering the fields every object carries, plus the
 * context only chant can add.
 */

import type { K8sObject } from "@intentius/chant-k8s-client";
import { formatUnobserved } from "@intentius/chant/observation";
import { defaultK8sConnector, type K8sConnector } from "../api/connect";
import { classifyApiFailure } from "../api/classify";
import { statusFromObject } from "../describe-resources";
import { kubeConnect } from "./connect";
import { parseKubeFlags, connectOptionsFrom } from "./flags";
import { loadKubeProjectContext, relativeProvenance, type KubeProjectContext } from "./project";
import { resolveKubeTarget, matchLiveObject, isTargetError, type KubeTarget } from "./target";
import { verdictFor } from "./verdict";
import { relativeAge } from "./render";
import { listEvents, filterInvolved, renderEvents } from "./events";

export interface DescribeDeps {
  connect?: K8sConnector;
  loadProject?: (cwd?: string) => Promise<KubeProjectContext | undefined>;
}

function targetLabel(target: KubeTarget): string {
  return "apiVersion" in target.selector ? target.selector.kind : target.selector.resource;
}

function keyValueBlock(m: Record<string, string> | undefined): string {
  if (!m || Object.keys(m).length === 0) return "<none>";
  const entries = Object.entries(m);
  return entries.map(([k, v], i) => (i === 0 ? `${k}=${v}` : `              ${k}=${v}`)).join("\n");
}

function indentedJson(value: unknown): string {
  return JSON.stringify(value, null, 2)
    .split("\n")
    .map((l) => `  ${l}`)
    .join("\n");
}

async function renderBlock(
  client: Parameters<typeof listEvents>[0],
  obj: K8sObject,
  info: { apiVersion: string; kind: string },
  project: KubeProjectContext | undefined,
): Promise<string> {
  const lines: string[] = [];
  lines.push(`Name:         ${obj.metadata?.name ?? ""}`);
  if (obj.metadata?.namespace) lines.push(`Namespace:    ${obj.metadata.namespace}`);
  lines.push(`API Version:  ${obj.apiVersion ?? info.apiVersion}`);
  lines.push(`Kind:         ${obj.kind ?? info.kind}`);
  lines.push(`Labels:       ${keyValueBlock(obj.metadata?.labels)}`);
  lines.push(`Annotations:  ${keyValueBlock(obj.metadata?.annotations)}`);
  lines.push(`Created:      ${obj.metadata?.creationTimestamp ?? "<unknown>"} (${relativeAge(obj.metadata?.creationTimestamp)} ago)`);
  lines.push(`Status:       ${statusFromObject(obj)}`);

  lines.push("Chant:");
  if (!project) {
    lines.push("  Verdict:    unavailable (not running inside a chant project)");
  } else {
    const match = matchLiveObject(project, {
      apiVersion: obj.apiVersion ?? info.apiVersion,
      kind: obj.kind ?? info.kind,
      name: obj.metadata?.name ?? "",
      namespace: obj.metadata?.namespace,
    });
    lines.push(`  Verdict:    ${verdictFor(obj, match)}`);
    if (match) {
      const prov = relativeProvenance(project, match.entity);
      lines.push(`  Entity:     ${match.entityName}`);
      lines.push(`  Source:     ${prov?.sourceFile ?? "(unknown)"}${prov?.composite ? ` (via ${prov.composite})` : ""}`);
    }
  }

  if (obj.spec !== undefined) {
    lines.push("Spec:");
    lines.push(indentedJson(obj.spec));
  }
  if (obj.status !== undefined) {
    lines.push("Status:");
    lines.push(indentedJson(obj.status));
  }

  try {
    const events = await listEvents(client, { namespace: obj.metadata?.namespace });
    const involved = filterInvolved(events, { kind: obj.kind ?? info.kind, name: obj.metadata?.name ?? "" });
    lines.push("Events:");
    lines.push(renderEvents(involved));
  } catch {
    lines.push("Events:       <could not be read>");
  }

  return lines.join("\n");
}

export async function runDescribe(rawArgs: string[], deps: DescribeDeps = {}): Promise<number> {
  const connect = deps.connect ?? defaultK8sConnector;
  const loadProject = deps.loadProject ?? loadKubeProjectContext;

  let flags;
  try {
    flags = parseKubeFlags(rawArgs);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  const project = await loadProject();
  const target = resolveKubeTarget(flags.positional, flags.values.namespace, project);
  if (isTargetError(target)) {
    console.error(`error: ${target.error}`);
    return 1;
  }

  const connected = await kubeConnect(connectOptionsFrom(flags.values), connect);
  if (connected.kind === "unobserved") {
    console.error(formatUnobserved(targetLabel(target), { reason: connected.reason, detail: connected.detail }));
    return 1;
  }
  const { client } = connected;

  let info;
  try {
    info = await client.resolve(target.selector);
  } catch (err) {
    const outcome = classifyApiFailure(err);
    console.error(
      formatUnobserved(targetLabel(target), {
        reason: outcome.kind === "unobserved" ? outcome.reason : "read-failed",
        detail: outcome.kind === "unobserved" ? outcome.detail : String(err),
      }),
    );
    return 1;
  }
  if (!info) {
    console.error(`error: the server doesn't have a resource type "${targetLabel(target)}"`);
    return 1;
  }

  const namespace = flags.flags.allNamespaces ? undefined : (target.namespace ?? client.defaultNamespace);
  const ref = { apiVersion: info.apiVersion, kind: info.kind };

  let objects: K8sObject[];
  if (target.name) {
    try {
      const obj = await client.readIfPresent({ ...ref, name: target.name, ...(namespace ? { namespace } : {}) });
      if (!obj) {
        console.error(`Error from server (NotFound): ${info.name} "${target.name}" not found`);
        return 1;
      }
      objects = [obj];
    } catch (err) {
      const outcome = classifyApiFailure(err);
      console.error(
        formatUnobserved(`${info.kind}/${target.name}`, {
          reason: outcome.kind === "unobserved" ? outcome.reason : "read-failed",
          detail: outcome.kind === "unobserved" ? outcome.detail : String(err),
        }),
      );
      return 1;
    }
  } else {
    try {
      objects = await client.list(ref, {
        ...(namespace ? { namespace } : {}),
        ...(flags.values.selector ? { labelSelector: flags.values.selector } : {}),
      });
    } catch (err) {
      const outcome = classifyApiFailure(err);
      console.error(
        formatUnobserved(info.kind, {
          reason: outcome.kind === "unobserved" ? outcome.reason : "read-failed",
          detail: outcome.kind === "unobserved" ? outcome.detail : String(err),
        }),
      );
      return 1;
    }
  }

  if (objects.length === 0) {
    console.log("No resources found.");
    return 0;
  }

  const blocks = await Promise.all(objects.map((obj) => renderBlock(client, obj, info, project)));
  console.log(blocks.join("\n\n\n"));
  return 0;
}
