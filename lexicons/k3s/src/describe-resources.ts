/**
 * Live observation for declared k3s Server/Agent entities (#1603).
 *
 * Mirrors the #1412 k3d answer for the k3s shape, and reuses the same
 * `k8s.profiles.<env>.context` binding helm and the k8s lexicon read
 * (`@intentius/chant/kubectl-context`, #1488): the kubectl context is a
 * property of the cluster chant talks to, not of any one lexicon, so k3s
 * does not invent a second binding namespace for the same thing.
 *
 * ## What this can honestly say
 *
 * A declared `K3s::Server` / `K3s::Agent` is chant's description of one node
 * joining a cluster. From where chant runs — never the host itself — the
 * only observables are ones the apiserver answers:
 *
 *   - the declared kubectl context exists and answers at all (`kubectl
 *     version`), which also reports the live k3s build so a caller can see
 *     it against the pin (`K3S_VERSION`);
 *   - the node the entity names is registered and its `Ready` condition.
 *
 * Everything that would require reaching the host directly — whether the
 * `k3s` systemd unit is up, what `/etc/rancher/k3s/config.yaml` currently
 * holds on disk — is out of scope. That is the provisioning boundary #1598
 * draws, and this reader never crosses it.
 *
 * `K3s::Registries` has no live counterpart at all: `registries.yaml` is
 * consumed once at containerd startup and leaves no object an apiserver
 * serves, so it reads `unsupported-kind` — honest, not a gap to close here.
 *
 * ## Node identity
 *
 * The only address chant can back up is a declared `node-name`. Unset, k3s
 * registers the node under the host's own hostname — which chant, running
 * off the host, cannot know or guess. An entity with no `node-name` is
 * `read-failed`, never a guessed address and never `absent`.
 *
 * ## Ownership rides node-label (#1603)
 *
 * The serializer stamps chant's marker into `node-label` when a build carries
 * ownership (`./serializer.ts`), which lands on the registered Node as
 * ordinary Kubernetes labels — the durable channel a host config file has no
 * other way to carry. Read back here the same way every label-based lexicon
 * does (`LABEL_OWNERSHIP_KEYS`).
 *
 * ## Tri-state (#1089, and the #1488 lesson)
 *
 * An unreachable apiserver — context missing, connection refused, no
 * credentials — is `read-failed`/`no-credentials`/`no-binding` for every
 * declared entity, naming the context that was actually read, never
 * `absent`. Only a genuine per-node `NotFound` is absence.
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { DescribeResourcesResult } from "@intentius/chant/lexicon";
import {
  observeEntities,
  type DeclaredEntity,
  type EntityObservation,
  type ObserverAdapter,
} from "@intentius/chant/observation";
import { classifyOwnership, LABEL_OWNERSHIP_KEYS } from "@intentius/chant/ownership";
import { loadChantConfigUpward } from "@intentius/chant/config";
import { resolveClusterTarget, classifyKubectlFailure } from "@intentius/chant/kubectl-context";
import { SERVER_TYPE, AGENT_TYPE } from "./serializer";
import { K3S_VERSION } from "./spec/fetch";

/** Injectable command runner, so tests drive every branch without kubectl or a cluster. */
export type ExecFn = (command: string) => Promise<{ stdout: string }>;

const execAsync = promisify(exec);

/** Shell-quote one argv element (same convention as helm's release-observe). */
function q(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

/**
 * The environment's kube context (#1488): the declared `k8s.profiles.<env>`
 * binding when present, ambient otherwise. This is deliberately the SAME
 * binding the k8s and helm lexicons read — a cluster is one target however
 * many lexicons observe it — not a `k3s.profiles` of its own.
 */
export async function resolveK3sContext(environment: string): Promise<string | undefined> {
  try {
    const { config } = await loadChantConfigUpward(process.cwd());
    return (await resolveClusterTarget(config as Record<string, unknown>, environment, "k3s")).context;
  } catch {
    return undefined;
  }
}

/** The declared node identity: the `node-name` flag, chant's only honest
 * source. Absent means k3s will name the node after the host's own hostname
 * — unknowable from here, so there is nothing to query by. */
export function declaredNodeName(entity: DeclaredEntity): string | undefined {
  const name = (entity.props as Record<string, unknown> | undefined)?.["node-name"];
  return typeof name === "string" && name.length > 0 ? name : undefined;
}

interface K3sNodeCondition {
  type?: string;
  status?: string;
  reason?: string;
}

interface K3sNode {
  metadata?: {
    uid?: string;
    labels?: Record<string, string>;
    creationTimestamp?: string;
  };
  status?: {
    nodeInfo?: { kubeletVersion?: string };
    conditions?: K3sNodeCondition[];
  };
}

/** The node's `Ready` condition as a status word: no condition at all reads
 * `unknown` (asked, and the object said nothing) rather than a guess. */
function nodeReadyStatus(node: K3sNode): string {
  const ready = node.status?.conditions?.find((c) => c.type === "Ready");
  if (!ready) return "unknown";
  if (ready.status === "True") return "Ready";
  return ready.reason && ready.reason.length > 0 ? ready.reason : "NotReady";
}

function pruneUndefined<T extends Record<string, unknown>>(obj: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

interface K3sClient {
  exec: ExecFn;
  ctxFlag: string;
  /** `kubectl version`'s serverVersion.gitVersion — the live k3s build. */
  k3sVersion?: string;
}

function adapter(execFn: ExecFn, environment: string): ObserverAdapter<K3sClient> {
  // Captured so a bind() failure can name the exact context it tried,
  // per the #1488 lesson — a bare kubectl error rarely does.
  let contextTried: string | undefined;

  return {
    async bind() {
      const context = await resolveK3sContext(environment);
      contextTried = context;
      const ctxFlag = context ? ` --context ${q(context)}` : "";

      const { stdout } = await execFn(`kubectl version -o json${ctxFlag}`);
      const parsed = JSON.parse(stdout) as { serverVersion?: { gitVersion?: string } };
      return { exec: execFn, ctxFlag, k3sVersion: parsed.serverVersion?.gitVersion };
    },

    classifyBindFailure(err) {
      const outcome = classifyKubectlFailure(err);
      const named = contextTried
        ? `context "${contextTried}" (from k8s.profiles.${environment}.context)`
        : "the ambient kubectl context (no k8s.profiles binding declared)";
      const raw = outcome.kind === "unobserved" ? outcome.detail : err instanceof Error ? err.message.split("\n")[0] : String(err);
      const reason = outcome.kind === "unobserved" ? outcome.reason : "read-failed";
      return { reason, detail: `${named}: ${raw}` };
    },

    async read(client, entity): Promise<EntityObservation> {
      if (entity.type !== SERVER_TYPE && entity.type !== AGENT_TYPE) {
        return { unobserved: { reason: "unsupported-kind", detail: entity.type } };
      }

      const name = declaredNodeName(entity);
      if (!name) {
        return {
          unobserved: {
            reason: "read-failed",
            detail:
              "no `node-name` declared — unset, k3s names the node after the host's own hostname, which chant cannot know from here",
          },
        };
      }

      const command = `kubectl get node ${q(name)} -o json${client.ctxFlag}`;
      try {
        const { stdout } = await client.exec(command);
        const node = JSON.parse(stdout) as K3sNode;
        const ownership = classifyOwnership(node.metadata?.labels, LABEL_OWNERSHIP_KEYS);

        return {
          present: {
            type: entity.type,
            physicalId: node.metadata?.uid ?? name,
            status: nodeReadyStatus(node),
            lastUpdated: node.metadata?.creationTimestamp,
            ownership,
            attributes: pruneUndefined({
              nodeName: name,
              kubeletVersion: node.status?.nodeInfo?.kubeletVersion,
              k3sVersion: client.k3sVersion,
              versionMatchesPin: client.k3sVersion ? client.k3sVersion === K3S_VERSION : undefined,
              labels: node.metadata?.labels,
            }),
          },
          queried: command,
        };
      } catch (err) {
        const outcome = classifyKubectlFailure(err);
        if (outcome.kind === "absent") return { absent: true, queried: command };
        return { unobserved: { reason: outcome.reason, detail: outcome.detail }, queried: command };
      }
    },
  };
}

export interface DescribeResourcesOptions {
  environment: string;
  buildOutput: string;
  entityNames: string[];
  entities: Map<string, { entityType: string; props: Record<string, unknown> }>;
  /** Restrict to chant-owned nodes (#1348). Withheld foreign nodes are
   * `filtered`, never a silent drop into `absent`. */
  owned?: boolean;
}

export async function describeResources(
  options: DescribeResourcesOptions,
  execFn: ExecFn = execAsync,
): Promise<DescribeResourcesResult> {
  const declared: DeclaredEntity[] = options.entityNames.map((name) => {
    const entity = options.entities.get(name);
    return {
      name,
      type: entity?.entityType ?? "",
      props: entity?.props ?? {},
    };
  });

  const result = await observeEntities(declared, adapter(execFn, options.environment));
  if (!options.owned) return result;

  // `--owned`: withhold a node that is present but carries no chant marker.
  // Withheld is `filtered`, never absent — a foreign node still exists.
  const resources = { ...result.resources };
  const unobserved = { ...result.unobserved };
  for (const [name, meta] of Object.entries(result.resources)) {
    if (meta.ownership === "owned") continue;
    delete resources[name];
    unobserved[name] = {
      type: meta.type,
      reason: "filtered",
      detail: "live node carries no chant ownership marker and --owned was requested",
      ...(result.queried?.[name] ? { queried: result.queried[name] } : {}),
    };
  }
  return { ...result, resources, unobserved };
}
