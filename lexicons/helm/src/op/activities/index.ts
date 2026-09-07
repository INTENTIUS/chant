/**
 * helm Op activities — resolved by the core activity registry when a project's
 * `chant.config.ts` lists the `helm` lexicon. `helmInstall` shells out to the
 * helm CLI, retried under the step's profile; relocated from the hosting
 * lexicon (#809) so helm's imperative activity lives with its product. The
 * `helmInstall` step builder stays in core and reaches authors through
 * `@intentius/chant/op` like the other core builders.
 */
export {
  helmInstall,
  helmInstallInputDigest,
  CapabilityProfileMismatchError,
  PinnedRenderNotFoundError,
  PinnedRenderIntegrityError,
  PinnedInstallInputError,
  PinnedProfileMismatchError,
} from "./helm";
export type {
  HelmInstallArgs,
  HelmInstallResult,
  HelmCapabilityProfile,
  HelmProfileAssertionOutcome,
} from "./helm";
export { probeClusterCapabilities, compareCapabilityProfile, ClusterProbeError } from "./cluster-probe";
export type { LiveClusterCapabilities, DeclaredCapabilityProfile } from "./cluster-probe";
