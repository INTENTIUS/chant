/**
 * Getting-started example for the fountain lexicon.
 *
 * Declares a minimal concierge stack: a locked-down Environment, an Agent
 * attached to it, and a Vault of overridable staging config. Serializes to
 * fountain's native manifests (`apiVersion: fountain.dev/v1`), applyable
 * with `fountain apply -f` or via the fountainApply op.
 */

import { Environment, Vault, Agent } from "@intentius/chant-lexicon-fountain";

export const conciergeEnv = new Environment({
  name: "concierge-env",
  packages: { node: "24" },
  // Explicit networking is required by FTN010 — an open sandbox by
  // silence is not a reviewed decision.
  networking_type: "limited",
  networking_config: { allowed_hosts: ["registry.npmjs.org", "github.com"] },
  env_vars: { LOG_LEVEL: "info" },
  metadata: { "managed-by": "chant" },
});

export const stagingCreds = new Vault({
  name: "staging-creds",
  description: "Per-environment overrides — vault values win on key collision.",
  metadata: { "managed-by": "chant" },
});

export const researcher = new Agent({
  name: "researcher",
  model: "anthropic/claude-sonnet-4-6",
  runtime: "claude",
  environment: conciergeEnv,
  skills: [{ source: "vercel-labs/agent-skills", ref: "main" }],
  metadata: { "managed-by": "chant" },
});
