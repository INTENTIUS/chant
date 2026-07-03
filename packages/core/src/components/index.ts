/**
 * Component-native release orchestration — capability contract + starter verb
 * set (epic #551). This phase (#554) ships the typed interface, registry, and
 * stubs only; no cloud implementation and no orchestrator/driver yet.
 * See https://intentius.io/chant/components/capabilities/
 */

export {
  type Capability,
  type CapabilityInput,
  type CapabilityOutput,
  type DeployContext,
  CapabilityRegistry,
  CapabilityNotImplementedError,
} from "./capability";
export { createCapabilityRegistry, STARTER_VERB_FAMILIES } from "./registry";
export * from "./verbs/index";
