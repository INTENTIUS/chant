/**
 * The pulumi lexicon's capability plugin (#4455). It adds no verbs: what it
 * carries is {@link pulumiStackOutputSource}, the source core's
 * `member-outputs` reads a workspace member of kind `pulumi` through. A
 * project that lists `pulumi` among its lexicons gets it bound into
 * `member-outputs` when its registry is built
 * (`loadCapabilityPluginsFromLexicons`, `registerCapabilityPlugins`).
 */
import type { Capability } from "@intentius/chant/components/capability";
import { ownPackageVersion, type CapabilityPlugin } from "@intentius/chant/components/capability-plugin";
import type { EngineOutputSource } from "@intentius/chant/components/verbs/member-outputs";
import { pulumiStackOutputSource } from "./member-outputs";

export const pulumiCapabilityPlugin: CapabilityPlugin = {
  name: "pulumi",
  get version(): string {
    return ownPackageVersion(import.meta.url);
  },
  capabilities(): Array<Capability<never, unknown>> {
    return [];
  },
  engineOutputSources(): EngineOutputSource[] {
    return [pulumiStackOutputSource];
  },
};
