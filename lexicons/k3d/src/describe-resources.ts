/**
 * Live observation for declared k3d clusters (#1412).
 *
 * The read is two commands: `k3d cluster list -o json` for presence and
 * running state, and `docker inspect` on the cluster's first server node for
 * the ownership marker — k3d's list output carries a `runtimeLabels` field
 * but only k3d's own `k3d.*` labels appear in it, so the custom labels the
 * serializer stamps via `options.runtime.labels` are only visible to Docker.
 * Verified live before this was written; see #1412.
 *
 * The tri-state is the whole report (#1089): a declared cluster is present,
 * absent, or not-observed-with-a-reason. k3d or Docker being unavailable is
 * `read-failed` for everything — never absence, because proposing to create
 * a cluster while Docker is stopped is the false finding the contract
 * exists to prevent. There is no property-level drift here on purpose: the
 * declared config is an input to creation, not a spec k3d reconciles
 * against, so node counts diverging is not "drift" anyone can act on.
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

const execAsync = promisify(exec);

const CLUSTER_TYPE = "K3d::Cluster";

/** The two commands the observer runs, injectable for tests. */
export type ExecFn = (command: string) => Promise<{ stdout: string }>;

interface K3dNode {
  name?: string;
  role?: string;
  State?: { Running?: boolean; Status?: string };
}

interface K3dClusterListEntry {
  name?: string;
  nodes?: K3dNode[];
  serversCount?: number;
  serversRunning?: number;
  agentsCount?: number;
  agentsRunning?: number;
}

/** The cluster name a declaration resolves to: metadata.name, else the entity name. */
export function declaredClusterName(entity: DeclaredEntity): string {
  const metadata = entity.props.metadata as Record<string, unknown> | undefined;
  const name = metadata?.name;
  return typeof name === "string" && name.length > 0 ? name : entity.name;
}

function clusterStatus(cluster: K3dClusterListEntry): string {
  const total = cluster.serversCount ?? cluster.nodes?.filter((n) => n.role === "server").length ?? 0;
  const running =
    cluster.serversRunning ??
    cluster.nodes?.filter((n) => n.role === "server" && n.State?.Running).length ??
    0;
  if (total === 0) return "unknown";
  if (running === 0) return "stopped";
  return running < total ? "degraded" : "running";
}

function adapter(execFn: ExecFn): ObserverAdapter<K3dClusterListEntry[]> {
  return {
    async bind() {
      const { stdout } = await execFn("k3d cluster list -o json");
      const parsed = JSON.parse(stdout || "[]");
      return Array.isArray(parsed) ? (parsed as K3dClusterListEntry[]) : [];
    },

    classifyBindFailure(err) {
      // k3d missing, Docker stopped, or unparsable output — all mean "could
      // not look", never "not there".
      const detail = err instanceof Error ? err.message.split("\n")[0] : String(err);
      return { reason: "read-failed", detail };
    },

    async read(clusters, entity): Promise<EntityObservation> {
      if (entity.type !== CLUSTER_TYPE) {
        return { unobserved: { reason: "unsupported-kind", detail: entity.type } };
      }

      const name = declaredClusterName(entity);
      const cluster = clusters.find((c) => c.name === name);
      if (!cluster) return { absent: true };

      // The marker lives on the server node's Docker labels; k3d's list JSON
      // does not surface custom labels, so ask Docker. A cluster that is
      // present but uninspectable still reports present — with the honest
      // `unknown` verdict rather than a guessed one.
      let ownership: "owned" | "foreign" | "unknown" = "unknown";
      try {
        const { stdout } = await execFn(
          `docker inspect k3d-${name}-server-0 --format '{{json .Config.Labels}}'`,
        );
        const labels = JSON.parse(stdout.trim().replace(/^'|'$/g, "") || "{}") as Record<string, unknown>;
        ownership = classifyOwnership(labels, LABEL_OWNERSHIP_KEYS);
      } catch {
        ownership = "unknown";
      }

      return {
        present: {
          type: CLUSTER_TYPE,
          physicalId: name,
          status: clusterStatus(cluster),
          ownership,
          attributes: {
            servers: cluster.serversCount ?? undefined,
            agents: cluster.agentsCount ?? undefined,
            serversRunning: cluster.serversRunning ?? undefined,
          },
        },
      };
    },
  };
}

export async function describeResources(
  options: {
    entityNames: string[];
    entities: Map<string, { entityType: string; props: Record<string, unknown> }>;
  },
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

  return observeEntities(declared, adapter(execFn));
}
