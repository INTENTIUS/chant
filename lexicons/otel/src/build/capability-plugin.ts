/**
 * `otelCapabilityPlugin`, the otel lexicon's capability plugin (#3374). One
 * build verb, `ocb-build`, contributed through core's `CapabilityPlugin`
 * contract as helm contributes `helm-upgrade`: a project declaring
 * `lexicons: ["otel"]` gets it registered when it runs components.
 */
import type { Capability } from "@intentius/chant/components/capability";
import type { BuildSpec } from "@intentius/chant/components/component";
import { ownPackageVersion, type CapabilityPlugin } from "@intentius/chant/components/capability-plugin";
import { ocbBuildCapability, type OcbBuildInput } from "./ocb-build";

export const OTEL_VERB_FAMILIES = {
  build: ["ocb-build"],
} as const;

export const otelCapabilityPlugin: CapabilityPlugin = {
  name: "otel",
  version: ownPackageVersion(import.meta.url),
  capabilities(): Array<Capability<never, unknown>> {
    return [ocbBuildCapability as Capability<never, unknown>];
  },
  families(): Record<string, readonly string[]> {
    return OTEL_VERB_FAMILIES;
  },
};

/** A component's `build` field for `ocb-build`: `build: ocbBuild({ config: "dist/builder-config.yaml" })`. */
export function ocbBuild(input: OcbBuildInput): BuildSpec {
  return { kind: "ocb-build", ...input };
}
