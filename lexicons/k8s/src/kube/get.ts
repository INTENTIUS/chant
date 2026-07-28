/**
 * `chant kube get` (chant #1079) — kubectl's own muscle-memory verb, plus the
 * chant verdict column the issue's acceptance criterion names.
 *
 * The cluster edge is the typed client (chant #1074/#1177), reached the same
 * way every other read does: `--env` resolves and honors the cluster
 * binding (chant #1100/#1155, refusing loudly on a mismatch), `--context` is
 * an explicit override, neither given falls back to the ambient kubeconfig
 * context. A connect failure, an RBAC-denied read, or a kind the cluster's
 * discovery has never heard of all render as an honest message rather than
 * an empty table — "No resources found." is reserved for the one case that
 * actually means it: the kind is real and there are zero live instances.
 */

import type { K8sObject } from "@intentius/chant-k8s-client";
import { formatUnobserved, type UnobservedEntity } from "@intentius/chant/observation";
import { defaultK8sConnector, type K8sConnector } from "../api/connect";
import { classifyApiFailure, isUnknownResource } from "../api/classify";
import { statusFromObject } from "../describe-resources";
import { kubeConnect } from "./connect";
import { parseKubeFlags, connectOptionsFrom } from "./flags";
import { loadKubeProjectContext, type KubeProjectContext } from "./project";
import { resolveKubeTarget, matchLiveObject, isTargetError, type KubeTarget } from "./target";
import { verdictFor } from "./verdict";
import {
  parseOutput,
  renderKubeTable,
  relativeAge,
  renderJson,
  renderYaml,
  renderName,
  renderChantSource,
  renderJsonPath,
  renderCustomColumns,
  type KubeRow,
} from "./render";

export interface GetDeps {
  connect?: K8sConnector;
  loadProject?: (cwd?: string) => Promise<KubeProjectContext | undefined>;
}

function targetLabel(target: KubeTarget): string {
  return "apiVersion" in target.selector ? target.selector.kind : target.selector.resource;
}

export async function runGet(rawArgs: string[], deps: GetDeps = {}): Promise<number> {
  const connect = deps.connect ?? defaultK8sConnector;
  const loadProject = deps.loadProject ?? loadKubeProjectContext;

  let flags;
  try {
    flags = parseKubeFlags(rawArgs);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  let output;
  try {
    output = parseOutput(flags.values.output);
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
    console.error(formatUnobserved(targetLabel(target), unobservedEntity(connected)));
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
      if (isUnknownResource(err)) {
        console.error(`error: the server doesn't have a resource type "${targetLabel(target)}"`);
        return 1;
      }
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

  switch (output.kind) {
    case "json":
      console.log(renderJson(objects));
      return 0;
    case "yaml":
      console.log(renderYaml(objects));
      return 0;
    case "name":
      console.log(renderName(objects));
      return 0;
    case "chant":
      console.log(renderChantSource(objects));
      return 0;
    case "jsonpath":
      console.log(renderJsonPath(output.expr, objects));
      return 0;
    case "custom-columns":
      console.log(renderCustomColumns(output.spec, objects));
      return 0;
  }

  const allNamespaces = flags.flags.allNamespaces ?? false;
  const rows: KubeRow[] = objects.map((obj) => {
    const match = matchLiveObject(project, {
      apiVersion: obj.apiVersion ?? info.apiVersion,
      kind: obj.kind ?? info.kind,
      name: obj.metadata?.name ?? "",
      namespace: obj.metadata?.namespace,
    });
    return {
      namespace: obj.metadata?.namespace,
      name: obj.metadata?.name ?? "",
      kind: info.kind,
      status: statusFromObject(obj),
      age: relativeAge(obj.metadata?.creationTimestamp),
      verdict: project ? verdictFor(obj, match) : "unavailable",
      labels: obj.metadata?.labels,
      object: obj,
    };
  });

  console.log(renderKubeTable(rows, { allNamespaces, wide: output.kind === "wide", showVerdict: true }));
  return 0;
}

function unobservedEntity(connected: { reason: UnobservedEntity["reason"]; detail: string }): UnobservedEntity {
  return { reason: connected.reason, detail: connected.detail };
}
