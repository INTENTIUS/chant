/**
 * ConfigConnectorContext composite — bootstrap Config Connector per-namespace context.
 *
 * @gke Creates a ConfigConnectorContext resource that configures
 * Config Connector to manage GCP resources in a specific namespace.
 */

import { Composite, mergeDefaults } from "@intentius/chant";
import { Deployment } from "../generated";

export interface ConfigConnectorContextProps {
  /** Context name (default: "configconnectorcontext.core.cnrm.cloud.google.com"). */
  name?: string;
  /** Google service account email for Config Connector to use. */
  googleServiceAccountEmail: string;
  /** Namespace for the context (default: "default"). */
  namespace?: string;
  /** Whether to sync status into spec (default: "absent"). */
  stateIntoSpec?: "absent" | "merge";
  /** Per-member defaults for fine-grained overrides. */
  defaults?: {
    context?: Partial<Record<string, unknown>>;
  };
}

export interface ConfigConnectorContextResult {
  context: InstanceType<typeof Deployment>; // CRD — use Deployment as proxy Declarable
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
export const ConfigConnectorContext = Composite<ConfigConnectorContextProps>((props) => {
  const {
    name = "configconnectorcontext.core.cnrm.cloud.google.com",
    googleServiceAccountEmail,
    namespace = "default",
    stateIntoSpec = "absent",
    defaults: defs,
  } = props;

  // ConfigConnectorContext is a CRD — use Deployment constructor as a generic Declarable wrapper
  const context = new Deployment(mergeDefaults({
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
  }, defs?.context));

  return { context };
}, "ConfigConnectorContext");
