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
  type: "file" | "url" | "cluster";
  /** File path for type="file" */
  path?: string;
  /** URL for type="url" */
  url?: string;
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
