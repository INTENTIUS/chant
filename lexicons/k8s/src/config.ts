/**
 * K8s environment → cluster binding — chant #1100.
 *
 * Every cloud lexicon binds an environment to a scope: AWS resolves `<env>`
 * to a CloudFormation stack, Azure treats `<env>` as the resource group,
 * Temporal looks up `temporal.profiles.<env>`. Before this, k8s bound
 * nothing — `describeResources` shelled out to `kubectl get` with no
 * `--context`, so `chant lifecycle diff prod --live` read whichever cluster
 * `kubectl config current-context` happened to point at.
 *
 * Add this to `chant.config.ts` to pin an environment to a cluster:
 *
 * ```ts
 * import type { K8sChantConfig } from "@intentius/chant-lexicon-k8s";
 *
 * export default {
 *   lexicons: ["k8s"],
 *   k8s: {
 *     profiles: {
 *       prod: { context: "prod-eks" },
 *       staging: { context: "staging-eks" },
 *     },
 *   } satisfies K8sChantConfig,
 * };
 * ```
 *
 * `describeResources` (in `./describe-resources.ts`, and the GCP lexicon's
 * Config Connector equivalent, which observes through the same kubectl path)
 * resolves this via `@intentius/chant/kubectl-context`'s
 * `resolveClusterTarget`:
 *
 * - A declared binding is passed explicitly as `kubectl ... --context <bound>`
 *   on every invocation, and checked against the ambient context first — a
 *   mismatch refuses loudly (naming the environment, the expected context,
 *   and the ambient one) instead of silently reading the wrong cluster.
 * - No binding for the environment keeps today's behavior — the ambient
 *   context — but logs a visible note that nothing is pinned, so the
 *   fallback is never silent.
 *
 * `ChantConfig` uses `.passthrough()` in its Zod schema so the `k8s` key is
 * accepted at runtime without core changes, exactly like `temporal.profiles`
 * (see `lexicons/temporal/src/config.ts`). The type side is the declaration
 * merge at the bottom of this file — without it the snippet above compiles
 * only until someone adds `satisfies ChantConfig`, which every example
 * project does and which is the only thing type-checking the rest of the
 * file (#1370).
 *
 * Deliberately out of scope here (see the issue for the full proposal):
 * deriving the binding automatically from a declared `AWS::EKS::Cluster` /
 * AKS / GKE cluster resource, and threading the resolved context into the
 * Op write path (`op/activities/kubectl.ts`, `wait-for-ready.ts`) — both
 * already accept an optional `context` a workflow author can pass, and can
 * call `resolveClusterTarget` themselves to agree with what the read path
 * resolved. This also keeps the binding available for #1073/#1074's future
 * typed API client to inherit, rather than re-deriving it.
 */

import type { ChantConfig } from "@intentius/chant/config";

/** A single environment's cluster binding. */
export interface K8sClusterProfile {
  /** kubectl context name this environment is bound to. */
  context: string;
}

export interface K8sChantConfig {
  /** Named environment → cluster bindings, keyed by environment name. */
  profiles?: Record<string, K8sClusterProfile>;
  /**
   * Exec credential-plugin commands chant may execute (chant #1074).
   *
   * On EKS, AKS and GKE, kubeconfig authentication is a subprocess:
   * `aws eks get-token`, `kubelogin`, `gke-gcloud-auth-plugin`. Those three
   * plus `kubectl` are allowed by default. Anything else the kubeconfig names
   * is refused, because an exec plugin is an arbitrary binary named in a file
   * chant did not write. Setting this **replaces** the default list.
   *
   * ```ts
   * k8s: {
   *   profiles: { prod: { context: "prod-eks" } },
   *   execCredentialPlugins: ["aws", "my-org-oidc-helper"],
   * } satisfies K8sChantConfig
   * ```
   */
  execCredentialPlugins?: string[];

  /**
   * Kustomize settings (#1548 piece 3).
   *
   * `roots` names kustomization directories that are build roots: each is
   * rendered (`kustomize build`, `kubectl kustomize` fallback) at build time
   * and the rendered documents join the manifest set — serialized into the
   * build output, ownership-stamped, checked by post-synth rules, and
   * observed by `lifecycle diff --live` like any declared resource. This is
   * how an estate that keeps its overlay tree gets a declared side without
   * converting a single manifest to typed source.
   *
   * Paths are relative to the project root (the directory holding
   * `chant.config.*`), NOT `sourceDir` — the overlay tree usually lives
   * beside the typed source, not inside it.
   *
   * ```ts
   * k8s: {
   *   kustomize: { roots: ["overlays/prod"] },
   * } satisfies K8sChantConfig
   * ```
   */
  kustomize?: {
    /** Kustomization directories to render into the build. */
    roots?: string[];
  };
}

declare module "@intentius/chant/config" {
  interface ChantConfig {
    k8s?: K8sChantConfig;
  }
}

/**
 * Compile-time proof that the augmentation above reaches `ChantConfig`, the
 * same guard the forgejo lexicon carries (#1344).
 *
 * Without it this line is `Property 'k8s' does not exist on type
 * 'ChantConfig'` — which is exactly the error a project got for writing the
 * documented snippet with `satisfies ChantConfig` (#1370). It lives here
 * rather than in a test because the root tsconfig excludes test files from
 * typechecking, so a compile-time claim asserted in one is checked by nothing.
 */
export type K8sConfigNamespace = NonNullable<ChantConfig["k8s"]>;
