/**
 * `k8sCapabilityPlugin` — the k8s lexicon's capability plugin (#1495 piece 2).
 *
 * One leaf for now: `kubectl-apply`, the shared apply verb Kubernetes levels
 * everything to (docs/components/cloud-boundary calls it the one portable
 * apply family). Contributed through core's `CapabilityPlugin` contract the
 * same way the aws lexicon contributes `cfn-deploy` — a project declaring
 * `lexicons: ["k8s"]` gets the verb registered automatically when it runs
 * components.
 */
import type { Capability } from "@intentius/chant/components/capability";
import { ownPackageVersion, type CapabilityPlugin } from "@intentius/chant/components/capability-plugin";
import { kubectlApplyCapability } from "./kubectl-apply";

export const K8S_VERB_FAMILIES = {
  apply: ["kubectl-apply"],
} as const;

export const k8sCapabilityPlugin: CapabilityPlugin = {
  name: "k8s",
  // The lexicon package's own version (#1505) — lockstep releases bump it, so
  // a literal here was stale one release after it was written.
  version: ownPackageVersion(import.meta.url),
  capabilities(): Array<Capability<never, unknown>> {
    return [kubectlApplyCapability as Capability<never, unknown>];
  },
  families(): Record<string, readonly string[]> {
    return K8S_VERB_FAMILIES;
  },
};
