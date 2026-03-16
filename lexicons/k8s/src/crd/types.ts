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
