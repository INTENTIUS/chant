/**
 * ConfigConnectorContext composite — bootstrap Config Connector per-namespace context.
 *
 * @gke Creates a ConfigConnectorContext resource that configures
 * Config Connector to manage GCP resources in a specific namespace.
 */

export interface ConfigConnectorContextProps {
  /** Context name (default: "configconnectorcontext.core.cnrm.cloud.google.com"). */
  name?: string;
  /** Google service account email for Config Connector to use. */
  googleServiceAccountEmail: string;
  /** Namespace for the context (default: "default"). */
  namespace?: string;
  /** Whether to sync status into spec (default: "absent"). */
  stateIntoSpec?: "absent" | "merge";
}

export interface ConfigConnectorContextResult {
  context: Record<string, unknown>;
}

/**
 * Create a ConfigConnectorContext composite — returns prop objects for
 * a ConfigConnectorContext resource.
 *
 * @gke
 * @example
 * ```ts
 * import { ConfigConnectorContext } from "@intentius/chant-lexicon-k8s";
 *
 * const { context } = ConfigConnectorContext({
 *   googleServiceAccountEmail: "cnrm@my-project.iam.gserviceaccount.com",
 *   namespace: "config-connector",
 * });
 * ```
 */
export function ConfigConnectorContext(
  props: ConfigConnectorContextProps,
): ConfigConnectorContextResult {
  const {
    name = "configconnectorcontext.core.cnrm.cloud.google.com",
    googleServiceAccountEmail,
    namespace = "default",
    stateIntoSpec = "absent",
  } = props;

  const contextProps: Record<string, unknown> = {
    apiVersion: "core.cnrm.cloud.google.com/v1beta1",
    kind: "ConfigConnectorContext",
    metadata: {
      name,
      namespace,
    },
    spec: {
      googleServiceAccount: googleServiceAccountEmail,
      stateIntoSpec,
    },
  };

  return { context: contextProps };
}
