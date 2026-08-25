/**
 * helm Op activities — resolved by the core activity registry when a project's
 * `chant.config.ts` lists the `helm` lexicon. `helmInstall` shells out to the
 * helm CLI with heartbeat/retry semantics; relocated from the temporal lexicon
 * (#809) so helm's imperative activity lives with its product, not in temporal.
 * The `helmInstall` step builder stays in core (@intentius/chant/op), re-exported
 * from the temporal Op-authoring barrel like the other core builders.
 */
export { helmInstall, helmInstallInputDigest, CapabilityProfileMismatchError } from "./helm";
export type {
  HelmInstallArgs,
  HelmInstallResult,
  HelmCapabilityProfile,
  HelmProfileAssertionOutcome,
} from "./helm";
export { probeClusterCapabilities, compareCapabilityProfile, ClusterProbeError } from "./cluster-probe";
export type { LiveClusterCapabilities, DeclaredCapabilityProfile } from "./cluster-probe";
