/**
 * Argo CD composites — turn Chant build targets into Argo `Application`s.
 *
 * The k8s lexicon stays runtime-agnostic: it only emits manifests. These
 * composites are the opt-in bridge to Argo CD's reconciliation layer. Authoring
 * an `Application` by hand is ~30 lines of nested YAML; `ArgoAppFor` collapses
 * it to one call with production-friendly defaults.
 *
 * - ArgoAppFor(target, opts)         → a single K8s::Argo::Application
 * - ArgoAppSetForRegions(regions, …) → one ApplicationSet, fanned out per region
 * - registerArgoCluster(opts)        → the cluster-registration Secret
 */

import { Composite, mergeDefaults } from "@intentius/chant";
import {
  Application as ApplicationResource,
  ApplicationSet as ApplicationSetResource,
  Secret as SecretResource,
} from "../generated";

// ── Shared types ─────────────────────────────────────────────────────────────

/** Where Argo deploys the synced manifests. `server` and `name` are exclusive. */
export interface ArgoDestination {
  /** Target cluster API server URL (e.g. https://kubernetes.default.svc). */
  server?: string;
  /** Registered cluster name (alternative to server). */
  name?: string;
  /** Namespace the synced resources land in. */
  namespace: string;
}

/** Argo sync policy. Omit `automated` for manual sync. */
export interface ArgoSyncPolicy {
  automated?: {
    /** Delete resources that disappear from git. Default false (and required
     * false on prod Applications — see ARGO001). */
    prune?: boolean;
    /** Revert out-of-band changes back to git state. */
    selfHeal?: boolean;
  };
  /** e.g. ["CreateNamespace=true", "ServerSideApply=true"]. */
  syncOptions?: string[];
}

const IN_CLUSTER_SERVER = "https://kubernetes.default.svc";

/** The default, safe sync policy: automated, non-pruning, self-healing. */
function defaultSyncPolicy(): ArgoSyncPolicy {
  return {
    automated: { prune: false, selfHeal: true },
    syncOptions: ["CreateNamespace=true"],
  };
}

function renderSyncPolicy(policy: ArgoSyncPolicy): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (policy.automated) {
    out.automated = {
      ...(policy.automated.prune !== undefined && { prune: policy.automated.prune }),
      ...(policy.automated.selfHeal !== undefined && { selfHeal: policy.automated.selfHeal }),
    };
  }
  if (policy.syncOptions && policy.syncOptions.length > 0) {
    out.syncOptions = policy.syncOptions;
  }
  return out;
}

function renderDestination(dest: ArgoDestination): Record<string, unknown> {
  return {
    ...(dest.server !== undefined && { server: dest.server }),
    ...(dest.name !== undefined && { name: dest.name }),
    namespace: dest.namespace,
  };
}

// ── ArgoAppFor ───────────────────────────────────────────────────────────────

export interface ArgoAppForOptions {
  /** Git repository URL the Application syncs from. */
  repo: string;
  /** Path within the repo holding the manifests. */
  path: string;
  /** Where Argo deploys. Defaults to the in-cluster target if omitted. */
  destination?: ArgoDestination;
  /** Git revision to track (default "HEAD"). */
  targetRevision?: string;
  /** AppProject the Application belongs to (default "default"). */
  project?: string;
  /** Namespace the Application object itself lives in (default "argocd"). */
  argoNamespace?: string;
  /** Sync policy. Omit for the safe automated default; pass `{}` for manual. */
  syncPolicy?: ArgoSyncPolicy;
  /** Extra labels applied to the Application. */
  labels?: Record<string, string>;
  defaults?: { application?: Partial<Record<string, unknown>> };
}

export type ArgoAppForResult = {
  application: InstanceType<typeof ApplicationResource>;
}

const ArgoApplication = Composite<{ target: string } & ArgoAppForOptions, ArgoAppForResult>(
  (props) => {
    const {
      target,
      repo,
      path,
      destination = { server: IN_CLUSTER_SERVER, namespace: target },
      targetRevision = "HEAD",
      project = "default",
      argoNamespace = "argocd",
      syncPolicy,
      labels = {},
      defaults,
    } = props;

    const resolvedSyncPolicy = syncPolicy ?? defaultSyncPolicy();
    const renderedSync = renderSyncPolicy(resolvedSyncPolicy);

    const application = new ApplicationResource(mergeDefaults({
      metadata: {
        name: target,
        namespace: argoNamespace,
        labels: {
          "app.kubernetes.io/name": target,
          "app.kubernetes.io/managed-by": "chant",
          ...labels,
        },
      },
      spec: {
        project,
        source: { repoURL: repo, path, targetRevision },
        destination: renderDestination(destination),
        ...(Object.keys(renderedSync).length > 0 && { syncPolicy: renderedSync }),
      },
    }, defaults?.application));

    return { application };
  },
  "ArgoApplication",
);

/**
 * Turn a Chant build target into an Argo CD `Application` in one call.
 *
 * @example
 * ```ts
 * import { ArgoAppFor } from "@intentius/chant-lexicon-k8s";
 *
 * export const api = ArgoAppFor("api", {
 *   repo: "https://github.com/acme/infra",
 *   path: "dist/api",
 *   destination: { server: "https://kubernetes.default.svc", namespace: "api" },
 * });
 * ```
 */
export function ArgoAppFor(target: string, options: ArgoAppForOptions): ArgoAppForResult {
  return ArgoApplication({ target, ...options });
}

// ── ArgoAppSetForRegions ─────────────────────────────────────────────────────

/** Per-region values resolved by the caller's mapper. */
export interface ArgoRegionTarget {
  /** Target cluster API server URL for this region. */
  server?: string;
  /** Registered cluster name for this region (alternative to server). */
  name?: string;
  /** Namespace the synced resources land in. */
  namespace: string;
  /** Per-region repo path (overrides the set-level path). */
  path?: string;
  /** Per-region git revision (overrides the set-level revision). */
  targetRevision?: string;
}

export interface ArgoAppSetForRegionsOptions {
  /** Base name; generated Applications are `<region>-<name>`. */
  name: string;
  /** Git repository URL the generated Applications sync from. */
  repo: string;
  /** Set-level repo path (per-region mapper may override). */
  path?: string;
  /** Single static AppProject for every generated Application (see ARGO004). */
  project?: string;
  /** Namespace the ApplicationSet object lives in (default "argocd"). */
  argoNamespace?: string;
  /** Set-level git revision (default "HEAD"). */
  targetRevision?: string;
  /** Sync policy applied to the template. Omit for the safe automated default. */
  syncPolicy?: ArgoSyncPolicy;
  /** Extra labels applied to the ApplicationSet. */
  labels?: Record<string, string>;
  defaults?: { applicationSet?: Partial<Record<string, unknown>> };
}

export type ArgoAppSetForRegionsResult = {
  applicationSet: InstanceType<typeof ApplicationSetResource>;
}

/**
 * Emit one `ApplicationSet` that fans out across regions via a list generator —
 * one synced Application per region, all scoped to a single AppProject.
 *
 * @example
 * ```ts
 * import { ArgoAppSetForRegions } from "@intentius/chant-lexicon-k8s";
 *
 * export const crdb = ArgoAppSetForRegions(
 *   ["east", "central", "west"],
 *   (region) => ({
 *     server: clusterServers[region],
 *     namespace: `crdb-${region}`,
 *     path: `dist/${region}`,
 *   }),
 *   { name: "crdb", repo: "https://github.com/acme/infra", project: "crdb" },
 * );
 * ```
 */
export function ArgoAppSetForRegions(
  regions: string[],
  fn: (region: string) => ArgoRegionTarget,
  options: ArgoAppSetForRegionsOptions,
): ArgoAppSetForRegionsResult {
  return ArgoApplicationSet({ regions, fn, options });
}

const ArgoApplicationSet = Composite<
  {
    regions: string[];
    fn: (region: string) => ArgoRegionTarget;
    options: ArgoAppSetForRegionsOptions;
  },
  ArgoAppSetForRegionsResult
>((props) => {
  const { regions, fn, options } = props;
  const {
    name,
    repo,
    path: setPath,
    project = "default",
    argoNamespace = "argocd",
    targetRevision: setRevision = "HEAD",
    syncPolicy,
    labels = {},
    defaults,
  } = options;

  // One list-generator element per region, carrying the resolved per-region
  // values the template interpolates.
  const elements = regions.map((region) => {
    const t = fn(region);
    const path = t.path ?? setPath;
    if (path === undefined) {
      throw new Error(
        `ArgoAppSetForRegions("${name}"): region "${region}" has no path — set options.path or return a path from the mapper.`,
      );
    }
    return {
      region,
      ...(t.server !== undefined && { server: t.server }),
      ...(t.name !== undefined && { clusterName: t.name }),
      namespace: t.namespace,
      path,
      targetRevision: t.targetRevision ?? setRevision,
    };
  });

  // Destination interpolates server or name depending on what the mapper gave.
  const usesServer = elements.every((e) => "server" in e);
  const destination: Record<string, unknown> = usesServer
    ? { server: "{{server}}", namespace: "{{namespace}}" }
    : { name: "{{clusterName}}", namespace: "{{namespace}}" };

  const resolvedSyncPolicy = syncPolicy ?? defaultSyncPolicy();
  const renderedSync = renderSyncPolicy(resolvedSyncPolicy);

  const applicationSet = new ApplicationSetResource(mergeDefaults({
    metadata: {
      name,
      namespace: argoNamespace,
      labels: {
        "app.kubernetes.io/name": name,
        "app.kubernetes.io/managed-by": "chant",
        ...labels,
      },
    },
    spec: {
      generators: [{ list: { elements } }],
      template: {
        metadata: { name: `{{region}}-${name}` },
        spec: {
          // Single static AppProject for the whole set (ARGO004).
          project,
          source: { repoURL: repo, path: "{{path}}", targetRevision: "{{targetRevision}}" },
          destination,
          ...(Object.keys(renderedSync).length > 0 && { syncPolicy: renderedSync }),
        },
      },
    },
  }, defaults?.applicationSet));

  return { applicationSet };
}, "ArgoApplicationSet");

// ── registerArgoCluster ──────────────────────────────────────────────────────

export interface RegisterArgoClusterOptions {
  /** Cluster name as Argo will know it (referenced by Application destinations). */
  name: string;
  /** Cluster API server URL. */
  server: string;
  /**
   * Argo cluster connection config (TLS, bearer token, exec auth). Serialized
   * into the Secret's `config` field. See the Argo CD cluster Secret format.
   */
  config?: Record<string, unknown> | string;
  /** Namespace Argo CD runs in (default "argocd"). */
  argoNamespace?: string;
  /** Extra labels (merged with the required secret-type label). */
  labels?: Record<string, string>;
  defaults?: { secret?: Partial<Record<string, unknown>> };
}

export type RegisterArgoClusterResult = {
  secret: InstanceType<typeof SecretResource>;
}

/**
 * Register an external cluster with Argo CD — emits the cluster Secret labelled
 * `argocd.argoproj.io/secret-type: cluster` that ARGO003 looks for.
 *
 * @example
 * ```ts
 * import { registerArgoCluster } from "@intentius/chant-lexicon-k8s";
 *
 * export const east = registerArgoCluster({
 *   name: "east",
 *   server: "https://east.example.com",
 *   config: { tlsClientConfig: { insecure: false } },
 * });
 * ```
 */
export function registerArgoCluster(options: RegisterArgoClusterOptions): RegisterArgoClusterResult {
  return ArgoClusterSecret(options);
}

const ArgoClusterSecret = Composite<RegisterArgoClusterOptions, RegisterArgoClusterResult>(
  (options) => {
    const { name, server, config, argoNamespace = "argocd", labels = {}, defaults } = options;

    const configString =
      config === undefined ? undefined : typeof config === "string" ? config : JSON.stringify(config);

    const secret = new SecretResource(mergeDefaults({
      metadata: {
        // Secret names can't contain characters from the server URL; use the
        // cluster name as the object name.
        name: `cluster-${name}`,
        namespace: argoNamespace,
        labels: {
          "argocd.argoproj.io/secret-type": "cluster",
          "app.kubernetes.io/managed-by": "chant",
          ...labels,
        },
      },
      type: "Opaque",
      stringData: {
        name,
        server,
        ...(configString !== undefined && { config: configString }),
      },
    }, defaults?.secret));

    return { secret };
  },
  "ArgoClusterSecret",
);
