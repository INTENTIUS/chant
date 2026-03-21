import { NamespaceEnv } from "@intentius/chant-lexicon-k8s";
import { localConfig } from "./config";

// Namespace with default-deny ingress NetworkPolicy.
// No ResourceQuota or LimitRange — local machine resources vary too much.
export const { namespace, defaultDenyIngressPolicy } = NamespaceEnv({
  name: localConfig.namespace,
  defaultDenyIngress: true,
});
