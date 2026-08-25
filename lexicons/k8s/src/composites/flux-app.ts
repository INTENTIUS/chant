/**
 * Flux CD composites — turn Chant build targets into Flux sources and
 * `Kustomization`s.
 *
 * The k8s lexicon stays runtime-agnostic: it only emits manifests. These
 * composites are the opt-in bridge to Flux's reconciliation layer, the
 * `ArgoAppFor` analogue for the source-controller/kustomize-controller pair.
 * Authoring a `GitRepository` + `Kustomization` by hand is ~40 lines of YAML
 * per app; `FluxAppFor` collapses the pair to one call with defaults taken
 * from real Flux estates.
 *
 * - FluxGitSource(name, opts) → a single K8s::Flux::GitRepository
 * - FluxAppFor(target, opts)  → a single K8s::Flux::Kustomization
 *
 * The two are split deliberately: the common estate shape is one source
 * shared by many Kustomizations. A `GitRepository` per app is the mistake
 * this split makes hard — declare the source once, hand its result to every
 * `FluxAppFor` that reconciles a path out of it.
 */

import { Composite, mergeDefaults } from "@intentius/chant";
import {
  GitRepository as GitRepositoryResource,
  Kustomization as KustomizationResource,
} from "../generated";

// ── Shared types ─────────────────────────────────────────────────────────────

/** The namespace the Flux controllers run in and watch by default. */
const FLUX_NAMESPACE = "flux-system";

/** knr-ops's name for the bootstrap-injected age identity Secret, and the
 * name `flux bootstrap` documentation uses. */
const SOPS_AGE_SECRET_NAME = "sops-age";

/** Source kinds a Kustomization can reconcile from. */
export type FluxSourceKind = "GitRepository" | "OCIRepository" | "Bucket";

/** An explicit reference to a source declared elsewhere. */
export interface FluxSourceRef {
  /** Source kind (default "GitRepository"). */
  kind?: FluxSourceKind;
  /** Name of the source object. */
  name: string;
  /** Namespace of the source, when it differs from the Kustomization's. */
  namespace?: string;
}

// ── FluxGitSource ────────────────────────────────────────────────────────────

export interface FluxGitSourceOptions {
  /** Git repository URL the source-controller fetches. */
  url: string;
  /** Branch to track (default "main"). Ignored when `tag` is set. */
  branch?: string;
  /** Tag to pin instead of a branch. */
  tag?: string;
  /** Fetch interval (default "5m"). */
  interval?: string;
  /** Name of the Secret holding git credentials, for private repos. */
  secretRef?: string;
  /** Namespace the GitRepository lives in (default "flux-system"). */
  fluxNamespace?: string;
  /** Extra labels applied to the GitRepository. */
  labels?: Record<string, string>;
  defaults?: { gitRepository?: Partial<Record<string, unknown>> };
}

export type FluxGitSourceResult = {
  gitRepository: InstanceType<typeof GitRepositoryResource>;
}

const FluxGitRepository = Composite<{ name: string } & FluxGitSourceOptions, FluxGitSourceResult>(
  (props) => {
    const {
      name,
      url,
      branch = "main",
      tag,
      interval = "5m",
      secretRef,
      fluxNamespace = FLUX_NAMESPACE,
      labels = {},
      defaults,
    } = props;

    const gitRepository = new GitRepositoryResource(mergeDefaults({
      metadata: {
        name,
        namespace: fluxNamespace,
        labels: {
          "app.kubernetes.io/name": name,
          "app.kubernetes.io/managed-by": "chant",
          ...labels,
        },
      },
      spec: {
        interval,
        url,
        // An unset spec.ref falls back to `master` — always pin (FLUX001).
        ref: tag !== undefined ? { tag } : { branch },
        ...(secretRef !== undefined && { secretRef: { name: secretRef } }),
      },
    }, defaults?.gitRepository));

    return { gitRepository };
  },
  "FluxGitRepository",
);

/**
 * Declare a Flux `GitRepository` source in one call.
 *
 * Declare it once and share it: every `FluxAppFor` that reconciles a path out
 * of the same repo should take this result as its `source`.
 *
 * @example
 * ```ts
 * import { FluxGitSource } from "@intentius/chant-lexicon-k8s";
 *
 * export const source = FluxGitSource("home-chant", {
 *   url: "https://github.com/jhgaylor/home-chant",
 *   branch: "main",
 * });
 * ```
 */
export function FluxGitSource(name: string, options: FluxGitSourceOptions): FluxGitSourceResult {
  return FluxGitRepository({ name, ...options });
}

// ── FluxAppFor ───────────────────────────────────────────────────────────────

export interface FluxAppForOptions {
  /**
   * The source to reconcile from — a `FluxGitSource` result, the name of an
   * existing `GitRepository` (e.g. the bootstrap-created "flux-system"), or an
   * explicit `{ kind, name }` reference for OCIRepository/Bucket sources.
   */
  source: FluxGitSourceResult | FluxSourceRef | string;
  /** Path within the source holding the manifests (e.g. "./apps/api/k8s"). */
  path: string;
  /** Namespace the reconciled resources land in (sets spec.targetNamespace). */
  targetNamespace?: string;
  /** Reconcile interval (default "10m"). */
  interval?: string;
  /** Delete resources that disappear from the source (default true). */
  prune?: boolean;
  /** Wait for reconciled resources to become ready (default true). */
  wait?: boolean;
  /**
   * Names of Kustomizations that must be ready first, as a plain name list
   * (rendered to spec.dependsOn). Validated against the build by FLUX003.
   */
  dependsOn?: string[];
  /** Timeout for health checks and apply operations. */
  timeout?: string;
  /** Pause reconciliation without deleting anything. */
  suspend?: boolean;
  /** ServiceAccount the kustomize-controller impersonates for this app. */
  serviceAccountName?: string;
  /**
   * SOPS decryption for the reconciled path. `"sops"` is shorthand for the
   * default age Secret name (`sops-age`); pass an object to name a different
   * one. Never inferred — the path this Kustomization reconciles is usually
   * the output of a *different* `chant build`, so the composite cannot know
   * whether it contains SOPS ciphertext. See WK8505 for the build-time check
   * that catches a committed-encrypted secret with no wiring here.
   */
  decryption?: "sops" | { provider: "sops"; secretRef?: string };
  /** Namespace the Kustomization object itself lives in (default "flux-system"). */
  fluxNamespace?: string;
  /** Extra labels applied to the Kustomization. */
  labels?: Record<string, string>;
  defaults?: { kustomization?: Partial<Record<string, unknown>> };
}

export type FluxAppForResult = {
  kustomization: InstanceType<typeof KustomizationResource>;
}

/** Resolve the `source` option to a rendered sourceRef. */
function resolveSourceRef(
  target: string,
  source: FluxGitSourceResult | FluxSourceRef | string,
): Record<string, unknown> {
  if (typeof source === "string") {
    return { kind: "GitRepository", name: source };
  }
  if ("gitRepository" in source && source.gitRepository !== undefined) {
    const metadata = (source.gitRepository as { props?: { metadata?: { name?: unknown; namespace?: unknown } } })
      .props?.metadata;
    const name = metadata?.name;
    if (typeof name !== "string" || name === "") {
      throw new Error(
        `FluxAppFor("${target}"): the supplied FluxGitSource result has no metadata.name to reference.`,
      );
    }
    return {
      kind: "GitRepository",
      name,
      ...(typeof metadata?.namespace === "string" && { namespace: metadata.namespace }),
    };
  }
  const ref = source as FluxSourceRef;
  return {
    kind: ref.kind ?? "GitRepository",
    name: ref.name,
    ...(ref.namespace !== undefined && { namespace: ref.namespace }),
  };
}

const FluxKustomization = Composite<{ target: string } & FluxAppForOptions, FluxAppForResult>(
  (props) => {
    const {
      target,
      source,
      path,
      targetNamespace,
      interval = "10m",
      prune = true,
      wait = true,
      dependsOn = [],
      timeout,
      suspend,
      serviceAccountName,
      decryption,
      fluxNamespace = FLUX_NAMESPACE,
      labels = {},
      defaults,
    } = props;

    const sourceRef = resolveSourceRef(target, source);
    const decryptionSpec = decryption === undefined
      ? undefined
      : {
        provider: "sops",
        secretRef: {
          name: typeof decryption === "string" ? SOPS_AGE_SECRET_NAME : decryption.secretRef ?? SOPS_AGE_SECRET_NAME,
        },
      };

    // The Kustomization's namespace also scopes the sourceRef: an in-spec
    // sourceRef without a namespace resolves in the Kustomization's own.
    const kustomization = new KustomizationResource(mergeDefaults({
      metadata: {
        name: target,
        namespace: fluxNamespace,
        labels: {
          "app.kubernetes.io/name": target,
          "app.kubernetes.io/managed-by": "chant",
          ...labels,
        },
      },
      spec: {
        interval,
        path,
        prune,
        wait,
        sourceRef,
        ...(targetNamespace !== undefined && { targetNamespace }),
        ...(dependsOn.length > 0 && { dependsOn: dependsOn.map((name) => ({ name })) }),
        ...(timeout !== undefined && { timeout }),
        ...(suspend !== undefined && { suspend }),
        ...(serviceAccountName !== undefined && { serviceAccountName }),
        ...(decryptionSpec !== undefined && { decryption: decryptionSpec }),
      },
    }, defaults?.kustomization));

    return { kustomization };
  },
  "FluxKustomization",
);

/**
 * Reconcile a Chant build target with Flux in one call — the `Kustomization`
 * half of the GitRepository + Kustomization pair. The source is passed in,
 * not created here, so many apps share one repo declaration.
 *
 * @example
 * ```ts
 * import { FluxGitSource, FluxAppFor } from "@intentius/chant-lexicon-k8s";
 *
 * export const source = FluxGitSource("home-chant", {
 *   url: "https://github.com/jhgaylor/home-chant",
 * });
 *
 * export const hello = FluxAppFor("hello-chant", {
 *   source,
 *   path: "./apps/hello-chant/k8s",
 *   targetNamespace: "default",
 *   dependsOn: ["cert-manager", "traefik"],
 * });
 * ```
 */
export function FluxAppFor(target: string, options: FluxAppForOptions): FluxAppForResult {
  return FluxKustomization({ target, ...options });
}
