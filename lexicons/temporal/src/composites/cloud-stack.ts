/**
 * TemporalCloudStack composite — a Temporal Cloud namespace + search attributes.
 *
 * Bundles a TemporalNamespace with an optional set of SearchAttribute entities.
 * No server resource is included — this composite assumes you are connecting
 * to Temporal Cloud (or a remotely managed server).
 *
 * @example
 * ```typescript
 * export const { ns, searchAttributes } = TemporalCloudStack({
 *   namespace: "prod",
 *   retention: "30d",
 *   searchAttributes: [
 *     { name: "Project", type: "Keyword" },
 *     { name: "Priority", type: "Int" },
 *   ],
 * });
 * ```
 */

import { TemporalNamespace, SearchAttribute } from "../resources";
import type { SearchAttributeProps } from "../resources";

export interface TemporalCloudStackConfig {
  /** Namespace name (required). */
  namespace: string;
  /**
   * Workflow history retention.
   * @default "30d"
   */
  retention?: string;
  /** Human-readable description for the namespace. */
  description?: string;
  /**
   * Search attribute definitions to register in this namespace.
   * Each entry creates a SearchAttribute entity scoped to this namespace.
   */
  searchAttributes?: Array<Pick<SearchAttributeProps, "name" | "type">>;
}

export interface TemporalCloudStackResources {
  ns: InstanceType<typeof TemporalNamespace>;
  searchAttributes: InstanceType<typeof SearchAttribute>[];
}

/**
 * Create a Temporal Cloud namespace stack.
 *
 * Returns a TemporalNamespace and an array of SearchAttribute entities.
 * Export the namespace and spread the search attributes from your chant project:
 *
 * ```typescript
 * export const { ns, searchAttributes } = TemporalCloudStack({ namespace: "prod" });
 * export const [projectAttr, priorityAttr] = searchAttributes;
 * ```
 */
export function TemporalCloudStack(config: TemporalCloudStackConfig): TemporalCloudStackResources {
  const ns = new TemporalNamespace({
    name: config.namespace,
    retention: config.retention ?? "30d",
    ...(config.description ? { description: config.description } : {}),
  } as Record<string, unknown>);

  const searchAttributes = (config.searchAttributes ?? []).map(
    ({ name, type }) =>
      new SearchAttribute({
        name,
        type,
        namespace: config.namespace,
      } as Record<string, unknown>),
  );

  return { ns, searchAttributes };
}
