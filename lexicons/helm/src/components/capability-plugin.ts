/**
 * `helmCapabilityPlugin` — the helm lexicon's capability plugin (#1495
 * piece 4).
 *
 * One leaf: `helm-upgrade`, the idempotent create-or-converge verb a Helm
 * release levels everything to. Contributed through core's `CapabilityPlugin`
 * contract the same way aws contributes `cfn-deploy` and k8s contributes
 * `kubectl-apply` — a project declaring `lexicons: ["helm"]` gets the verb
 * registered automatically when it runs components.
 */
import type { Capability } from "@intentius/chant/components/capability";
import { ownPackageVersion, type CapabilityPlugin } from "@intentius/chant/components/capability-plugin";
import { helmUpgradeCapability } from "./helm-upgrade";

export const HELM_VERB_FAMILIES = {
  apply: ["helm-upgrade"],
} as const;

export const helmCapabilityPlugin: CapabilityPlugin = {
  name: "helm",
  // The lexicon package's own version (#1505) — literals go stale every
  // lockstep release.
  version: ownPackageVersion(import.meta.url),
  capabilities(): Array<Capability<never, unknown>> {
    return [helmUpgradeCapability as Capability<never, unknown>];
  },
  families(): Record<string, readonly string[]> {
    return HELM_VERB_FAMILIES;
  },
};
