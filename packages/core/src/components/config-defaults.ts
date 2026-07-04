/**
 * Config-defaults pass (#629, epic #551 follow-up to #606/#622/#626) — the
 * missing link between `chant.config.ts`'s `sbom`/`signing`/`vulnPolicy`
 * sections and the steps that actually consume them.
 *
 * Before this module, `resolveSigningDefaults`/`resolveVulnPolicy`
 * (../config.ts) were never called anywhere in the `chant run --components`
 * path, and `resolveSbomFormat` was only ever called in post-hoc display
 * code. A component author had to hand-code `format`/`keyless`/`oidcIssuer`/
 * `policy` into every `generate-sbom`/`sign`/`attest-provenance`/`verify`/
 * `vuln-gate` step, even when the project already declared a project-wide
 * default in `chant.config.ts` — the config sections were decorative.
 *
 * `applyConfigDefaults` walks a `DriverComponent`'s `deploy` composition
 * (including nested fan-out phases and `onFailure` compensation phases) and
 * returns a new component with each recognized step's config-driven fields
 * filled in *only where the step didn't already set them* — per-step value
 * wins over config wins over the capability's own built-in default, the
 * precedence every one of the `resolve*` docstrings in ../config.ts already
 * claims. This module is the caller that finally makes that claim true.
 *
 * Kept entirely outside `./driver.ts`: the driver stays capability-agnostic
 * (it dispatches by `kind` and knows nothing about `sbom`/`signing`/
 * `vulnPolicy`) — this pass transforms the component's plain-data composition
 * *before* it ever reaches the driver, the same "resolve config, then hand a
 * capability-agnostic caller a fully-formed input" convention `resolveSbomFormat`'s
 * own docstring already describes for its callers.
 */

import type { ChantConfig } from "../config";
import { resolveSbomFormat, resolveSigningDefaults, resolveVulnPolicy } from "../config";
import type { DriverComponent, DriverGate, DriverPhase, DriverStep } from "./driver";

function isGateStep(step: DriverStep | DriverGate | DriverPhase): step is DriverGate {
  return (step as { kind?: unknown }).kind === "gate";
}

function isPhaseStep(step: DriverStep | DriverGate | DriverPhase): step is DriverPhase {
  return typeof (step as { phase?: unknown }).phase === "string" && Array.isArray((step as DriverPhase).steps);
}

/**
 * Fill one step's config-resolved defaults in place (into a shallow clone),
 * per its `kind` — the only place this module branches on capability kind,
 * matching how `../verbs/sbom.ts`'s `generate` is the only branch point for
 * artifact type. Fields the step already set are never overwritten.
 */
function applyStepDefaults(step: DriverStep, config: ChantConfig): DriverStep {
  switch (step.kind) {
    case "generate-sbom": {
      const format = (step as { format?: unknown }).format as
        | Parameters<typeof resolveSbomFormat>[1]
        | undefined;
      return { ...step, format: resolveSbomFormat(config, format) };
    }

    case "sign":
    case "attest-provenance": {
      const defaults = resolveSigningDefaults(config);
      const next: DriverStep = { ...step };
      // Only fill `keyless`/`key` when the step didn't already declare its own
      // signing method — an explicit `key` (or `keyless`) on the step always
      // wins over the project default, mirroring `resolveSigningDefaults`'s
      // own "caller supplies any per-call override" contract.
      if (next.keyless === undefined && next.key === undefined) {
        if (!defaults.keyless && defaults.key) {
          next.key = defaults.key;
        } else if (defaults.identityPolicyDefaults.expectedIssuer !== undefined) {
          // Keyless flow: thread the configured OIDC issuer through as a
          // `keyless` override so `cosign sign/attest --oidc-issuer` picks it
          // up, without clobbering any keyless sub-fields the step itself set.
          const existingKeyless = (next.keyless as Record<string, unknown> | undefined) ?? {};
          next.keyless = { oidcIssuer: defaults.identityPolicyDefaults.expectedIssuer, ...existingKeyless };
        }
      }
      return next;
    }

    case "verify": {
      const defaults = resolveSigningDefaults(config).identityPolicyDefaults;
      const existingPolicy = (step.policy as Record<string, unknown> | undefined) ?? {};
      const policy: Record<string, unknown> = { ...existingPolicy };
      if (policy.expectedIssuer === undefined && defaults.expectedIssuer !== undefined) {
        policy.expectedIssuer = defaults.expectedIssuer;
      }
      if (policy.expectedIdentity === undefined && defaults.expectedIdentity !== undefined) {
        policy.expectedIdentity = defaults.expectedIdentity;
      }
      if (policy.identityIsRegexp === undefined && defaults.identityIsRegexp !== undefined) {
        policy.identityIsRegexp = defaults.identityIsRegexp;
      }
      if (policy.key === undefined && defaults.key !== undefined) {
        policy.key = defaults.key;
      }
      return { ...step, policy };
    }

    case "vuln-gate": {
      const configPolicy = resolveVulnPolicy(config);
      const existingPolicy = (step.policy as Record<string, unknown> | undefined) ?? {};
      // Config policy fills the gaps; the step's own `policy` wins field-by-field.
      const policy: Record<string, unknown> = { ...configPolicy, ...existingPolicy };
      return { ...step, policy };
    }

    default:
      return step;
  }
}

/** Recursively apply step defaults across one entry (a step, a gate, or a nested fan-out phase). Gates are returned unchanged — they carry no capability input to resolve. */
function applyEntryDefaults(
  entry: DriverStep | DriverGate | DriverPhase,
  config: ChantConfig,
): DriverStep | DriverGate | DriverPhase {
  if (isGateStep(entry)) return entry;
  if (isPhaseStep(entry)) return applyPhaseDefaults(entry, config);
  return applyStepDefaults(entry, config);
}

/** Apply step defaults across one phase's `steps` (recursing into nested fan-out phases) and its `onFailure` compensation phases. */
function applyPhaseDefaults(phase: DriverPhase, config: ChantConfig): DriverPhase {
  return {
    ...phase,
    steps: phase.steps.map((entry) => applyEntryDefaults(entry, config)),
    ...(phase.onFailure ? { onFailure: phase.onFailure.map((p) => applyPhaseDefaults(p, config)) } : {}),
  };
}

/**
 * Return `component` with `chant.config.ts`'s `sbom`/`signing`/`vulnPolicy`
 * defaults filled into its `deploy` (and `rollback`, which shares the same
 * `DriverPhase[]` shape and can equally carry a `verify`/`vuln-gate` step)
 * composition, wherever a step didn't already specify the value itself.
 * Non-destructive: returns a new component/phase/step tree, never mutates
 * `component` in place, so a caller holding the original discovered
 * `DriverComponent` (e.g. for `chant describe`) is unaffected.
 */
export function applyConfigDefaults(component: DriverComponent, config: ChantConfig): DriverComponent {
  return {
    ...component,
    deploy: component.deploy.map((phase) => applyPhaseDefaults(phase, config)),
    ...(component.rollback ? { rollback: component.rollback.map((phase) => applyPhaseDefaults(phase, config)) } : {}),
  };
}
