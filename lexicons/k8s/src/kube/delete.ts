/**
 * `chant kube delete` (chant #1079) — routes through the typed client's own
 * `delete()` (`packages/k8s-client/src/client.ts`), the identical typed
 * delete `applyManifest`'s prune step already uses (chant #1075) — never a
 * second implementation. A kind and a name are both mandatory: there is no
 * bare `chant kube delete deployments` form, so nothing here can become a
 * sweep by omission (the issue's "nothing destructive happens without an
 * explicit resource argument").
 *
 * Two guardrails on top of the typed delete itself:
 *
 * - **Gate.** A bare invocation reads the object, reports what it found (and
 *   whether chant owns it), and stops — only `--yes` performs the delete.
 * - **Ownership, surfaced not enforced.** kubectl itself deletes anything
 *   RBAC allows, chant-applied or not, and this keeps that: an explicit name
 *   is already an informed decision. What's added is visibility — a
 *   warning when the object carries no chant ownership marker, so the
 *   operator knows they are about to delete something chant did not apply.
 */

import type { K8sClient } from "@intentius/chant-k8s-client";
import { ClusterBindingMismatchError } from "@intentius/chant/kubectl-context";
import { formatUnobserved, type UnobservedReason } from "@intentius/chant/observation";
import { hasOwnershipMarker, LABEL_OWNERSHIP_KEYS } from "@intentius/chant/ownership";
import { defaultK8sConnector, type K8sConnector } from "../api/connect";
import { classifyApiFailure } from "../api/classify";
import { kubeConnect } from "./connect";
import { parseKubeFlags, connectOptionsFrom } from "./flags";
import { loadKubeProjectContext, type KubeProjectContext } from "./project";
import { resolveKubeTarget, isTargetError, type KubeTarget } from "./target";

export interface DeleteDeps {
  connect?: K8sConnector;
  loadProject?: (cwd?: string) => Promise<KubeProjectContext | undefined>;
}

function targetLabel(target: KubeTarget): string {
  return "apiVersion" in target.selector ? target.selector.kind : target.selector.resource;
}

const PROPAGATION_POLICIES = new Set(["Foreground", "Background", "Orphan"]);

export async function runDelete(rawArgs: string[], deps: DeleteDeps = {}): Promise<number> {
  const connect = deps.connect ?? defaultK8sConnector;
  const loadProject = deps.loadProject ?? loadKubeProjectContext;

  let flags;
  try {
    flags = parseKubeFlags(rawArgs, {
      value: { "--propagation-policy": "propagationPolicy" },
      boolean: { "--yes": "yes", "-y": "yes" },
    });
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  if (flags.values.propagationPolicy !== undefined && !PROPAGATION_POLICIES.has(flags.values.propagationPolicy)) {
    console.error(`error: --propagation-policy must be one of Foreground, Background, Orphan`);
    return 1;
  }

  const project = await loadProject();
  const target = resolveKubeTarget(flags.positional, flags.values.namespace, project);
  if (isTargetError(target)) {
    console.error(`error: ${target.error}`);
    return 1;
  }
  if (!target.name) {
    console.error(
      "error: chant kube delete requires an explicit resource name — no bare kind sweeps " +
        "(e.g. `chant kube delete deployment web`, not `chant kube delete deployment`)",
    );
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

  const namespace = target.namespace ?? client.defaultNamespace;
  const ref = { apiVersion: info.apiVersion, kind: info.kind, name: target.name, namespace };

  const object = await readForDelete(client, ref);
  if (object.kind === "unobserved") {
    console.error(formatUnobserved(`${info.kind}/${target.name}`, { reason: object.reason, detail: object.detail }));
    return 1;
  }
  if (!object.found) {
    console.error(`Error from server (NotFound): ${info.name} "${target.name}" not found`);
    return 1;
  }

  const owned = hasOwnershipMarker(object.labels, LABEL_OWNERSHIP_KEYS);
  const label = `${info.kind}/${target.name}${namespace ? ` -n ${namespace}` : ""}`;

  if (!(flags.flags.yes ?? false)) {
    console.log(`Would delete ${label}${owned ? "" : " (warning: not chant-owned)"}. Pass --yes to delete for real.`);
    return 0;
  }

  if (!owned) {
    console.log(`warning: ${label} carries no chant ownership marker — deleting an object chant did not apply`);
  }

  try {
    await client.delete(
      { apiVersion: info.apiVersion, kind: info.kind, name: target.name, ...(namespace ? { namespace } : {}) },
      { ...(flags.values.propagationPolicy ? { propagationPolicy: flags.values.propagationPolicy as "Foreground" | "Background" | "Orphan" } : {}) },
    );
  } catch (err) {
    const outcome = classifyApiFailure(err);
    if (outcome.kind === "absent") {
      console.error(`Error from server (NotFound): ${info.name} "${target.name}" not found`);
      return 1;
    }
    console.error(
      formatUnobserved(label, {
        reason: outcome.kind === "unobserved" ? outcome.reason : "read-failed",
        detail: outcome.kind === "unobserved" ? outcome.detail : String(err),
      }),
    );
    return 1;
  }

  console.log(`${label} deleted`);
  return 0;
}

type ReadForDeleteResult =
  | { kind: "found"; found: true; labels: Record<string, string> | undefined }
  | { kind: "found"; found: false; labels: undefined }
  | { kind: "unobserved"; reason: UnobservedReason; detail: string };

async function readForDelete(
  client: K8sClient,
  ref: { apiVersion: string; kind: string; name: string; namespace?: string },
): Promise<ReadForDeleteResult> {
  try {
    const obj = await client.readIfPresent(ref);
    return obj ? { kind: "found", found: true, labels: obj.metadata?.labels } : { kind: "found", found: false, labels: undefined };
  } catch (err) {
    if (err instanceof ClusterBindingMismatchError) {
      return { kind: "unobserved", reason: "no-binding", detail: err.message };
    }
    const outcome = classifyApiFailure(err);
    return {
      kind: "unobserved",
      reason: outcome.kind === "unobserved" ? outcome.reason : "read-failed",
      detail: outcome.kind === "unobserved" ? outcome.detail : String(err),
    };
  }
}
