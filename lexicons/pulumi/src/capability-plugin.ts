/**
 * The pulumi lexicon's capability plugin (#4455). It contributes
 * `pulumi-up` (#4541, `./pulumi-up.ts`), which plans and applies a Pulumi or
 * plunge stack as a component step, and {@link pulumiStackOutputSource},
 * the source core's `member-outputs` reads a workspace member of kind
 * `pulumi` through. A project that lists `pulumi` among its lexicons gets
 * both registered when its registry is built
 * (`loadCapabilityPluginsFromLexicons`, `registerCapabilityPlugins`).
 */
import type { Capability } from "@intentius/chant/components/capability";
import { ownPackageVersion, type CapabilityPlugin } from "@intentius/chant/components/capability-plugin";
import type { EngineOutputSource } from "@intentius/chant/components/verbs/member-outputs";
import { pulumiStackOutputSource } from "./member-outputs";
import { pulumiUpCapability } from "./pulumi-up";

export const PULUMI_VERB_FAMILIES = {
  apply: ["pulumi-up"],
} as const;

export const pulumiCapabilityPlugin: CapabilityPlugin = {
  name: "pulumi",
  get version(): string {
    return ownPackageVersion(import.meta.url);
  },
  capabilities(): Array<Capability<never, unknown>> {
    return [pulumiUpCapability as Capability<never, unknown>];
  },
  families(): Record<string, readonly string[]> {
    return PULUMI_VERB_FAMILIES;
  },
  engineOutputSources(): EngineOutputSource[] {
    return [pulumiStackOutputSource];
  },
};
