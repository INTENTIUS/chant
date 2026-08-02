/**
 * CRD (Custom Resource Definition) framework types.
 *
 * Defines the data structures used to load, parse, and process
 * Kubernetes CRDs for code generation and lexicon extension.
 */

/**
 * Source from which to load CRD definitions.
 */
export interface CRDSource {
  /** How to fetch the CRD */
  type: "file" | "url" | "cluster" | "helm";
  /** File path for type="file" */
  path?: string;
  /** URL for type="url" */
  url?: string;
  /**
   * Chart reference for type="helm", e.g.
   * "oci://ghcr.io/codriverlabs/helm/kube-microvm-operator".
   *
   * Exists because operators built with the Java and Go operator SDKs
   * generate their CRDs at build time and ship them only inside the chart —
   * KubeMicroVM commits one of its five and publishes all five. A raw URL
   * cannot reach those, and pulling the chart is cheaper at generation time
   * than standing up a cluster to introspect.
   */
  chart?: string;
  /** Chart version for type="helm". Required: an unpinned source is not auditable. */
  version?: string;
  /**
   * Directory inside the chart holding the CRDs. Defaults to Helm's own
   * convention, "crds". Charts that instead template their CRDs need this
   * pointed at wherever they actually live.
   */
  chartSubdir?: string;
  /** Kubectl context for type="cluster" */
  context?: string;
  /** Namespace to scope the CRD lookup for type="cluster" */
  namespace?: string;
  /**
   * Optional allowlist of CRD `kind` names to keep from this source. When a
   * source is a multi-doc install bundle (as with Flux, whose release
   * `install.yaml` also carries out-of-scope CRDs), this restricts codegen to
   * the intended kinds. Omit to generate every CRD the source contains.
   */
  kinds?: string[];
}

/**
 * Parsed representation of a CRD's spec section.
 */
export interface CRDSpec {
  /** API group (e.g. "cert-manager.io") */
  group: string;
  /**
   * Whether instances are namespaced. Declared by the CRD itself, so it is the
   * authoritative source for a custom resource's scope — the equivalent of what
   * the OpenAPI `paths` say for built-in kinds (chant #1074). Defaults to
   * `Namespaced`, matching the API server's own default.
   */
  scope?: "Namespaced" | "Cluster";
  /** Name variants for the CRD */
  names: {
    kind: string;
    plural: string;
    singular?: string;
    shortNames?: string[];
  };
  /** API versions served by this CRD */
  versions: Array<{
    name: string;
    served: boolean;
    storage: boolean;
    schema?: Record<string, unknown>;
  }>;
}

/**
 * Full CRD document as parsed from YAML.
 */
export interface CRDDocument {
  apiVersion: string;
  kind: "CustomResourceDefinition";
  metadata: { name: string; [key: string]: unknown };
  spec: CRDSpec;
}
