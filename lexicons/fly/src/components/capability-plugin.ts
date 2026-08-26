/**
 * `flyCapabilityPlugin` — the fly lexicon's capability plugin (#1942, epic
 * #1564 phase 2).
 *
 * One leaf so far: `run-agent`, the sprite-lifecycle-backed agent-turn verb
 * (`./run-agent.ts`). Contributed through core's `CapabilityPlugin` contract
 * the same way aws contributes `cfn-deploy` and helm contributes
 * `helm-upgrade` (docs/components/cloud-boundary) — a project declaring
 * `lexicons: ["fly"]` gets `run-agent` registered automatically when it runs
 * components. Deliberately *not* part of core's always-on starter set
 * (`packages/core/src/components/starter-plugin.ts`) — `run-agent` opts a
 * project in via this lexicon the same way every other cloud-shaped leaf
 * does, rather than shipping to every project by default.
 */
import type { Capability } from "@intentius/chant/components/capability";
import { ownPackageVersion, type CapabilityPlugin } from "@intentius/chant/components/capability-plugin";
import { flyRunAgentCapability } from "./run-agent";

export const FLY_VERB_FAMILIES = {
  agentExecution: ["run-agent"],
} as const;

export const flyCapabilityPlugin: CapabilityPlugin = {
  name: "fly",
  // The lexicon package's own version (mirrors aws/helm's #1505 fix — a
  // getter so the package.json read happens on first access, not at import time).
  get version(): string {
    return ownPackageVersion(import.meta.url);
  },
  capabilities(): Array<Capability<never, unknown>> {
    return [flyRunAgentCapability as Capability<never, unknown>];
  },
  families(): Record<string, readonly string[]> {
    return FLY_VERB_FAMILIES;
  },
};
