/**
 * `chant init` scaffolding for fountain projects.
 *
 * Two templates. The default is the concierge posture — a locked sandbox
 * declared through `ConciergeStack`, since an agent environment that reaches
 * anything real should start closed and be opened by explicit parameter. The
 * `open` template is the loose counterpart for a research sandbox that touches
 * nothing sensitive, and says so in a comment rather than leaving a reader to
 * infer that the difference was deliberate.
 */

import type { InitTemplateSet } from "@intentius/chant/lexicon";

const CONCIERGE = `import { ConciergeStack } from "@intentius/chant-lexicon-fountain";

// A locked-down Environment + Agent pair. The defaults are the closed ones:
// deny-all egress (limited networking with an empty allowlist), no vault may
// override the reviewed environment at spawn, and the managed-by: chant marker
// on both so owned-only reconcile and drift see them.
//
// Loosening any of it is an explicit, reviewable parameter — add hosts to
// allowedHosts, ids to allowedVaultIds. Give the sandbox no cloud credentials:
// anything readable inside it is exfiltratable by prompt injection. Services
// the agent needs live outside the sandbox behind their own auth.
export const { environment, agent } = ConciergeStack({
  name: "concierge",
  model: "anthropic/claude-sonnet-4-6",
  allowedHosts: ["registry.npmjs.org", "github.com"],
});
`;

const OPEN = `import { Environment, Agent } from "@intentius/chant-lexicon-fountain";

// A research sandbox that touches nothing sensitive. networking_type is set
// explicitly because FTN010 requires the choice to be a reviewed one, not a
// default nobody looked at; FTN011 will still warn on unrestricted, which is
// the intended nudge — switch to limited with an allowed_hosts allowlist as
// soon as this environment holds anything worth stealing.
export const env = new Environment({
  name: "research-env",
  networking_type: "unrestricted",
  packages: { node: "24" },
  metadata: { "managed-by": "chant" },
});

export const researcher = new Agent({
  name: "researcher",
  model: "anthropic/claude-sonnet-4-6",
  runtime: "claude",
  environment: env,
  metadata: { "managed-by": "chant" },
});
`;

export function fountainInitTemplates(template?: string): InitTemplateSet {
  if (template === "open") {
    return { src: { "fountain.ts": OPEN } };
  }
  return { src: { "fountain.ts": CONCIERGE } };
}
