/**
 * WAW044: ALB HTTP Listener Not Redirecting To HTTPS (full tier)
 *
 * Flags load balancer Listener resources on Protocol: HTTP whose
 * DefaultActions don't redirect to HTTPS — the listener serves plaintext
 * traffic instead of upgrading it. Access logging is WAW024; this covers
 * transport security on the listener itself.
 *
 * Tier-aware (#917), same seam as WAW040/WAW052 (#894): a relaxed "light"
 * stack (local/Floci, or no --env/ownership.env set) only warns, since the
 * light tier is intentionally HTTP-only with no ACM cert to redirect to; the
 * strict "full"/production tier (ctx.env === "prod"/"production"/"full", the
 * existing #201 env seam — see isFullTierEnv) fails the build.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { parseCFTemplate, isIntrinsic, isFullTierEnv } from "./cf-refs";

function redirectsToHttps(actions: unknown): boolean {
  if (!Array.isArray(actions)) return false;
  return actions.some((action) => {
    if (typeof action !== "object" || action === null) return false;
    const a = action as Record<string, unknown>;
    if (a.Type !== "redirect") return false;
    const redirectConfig = a.RedirectConfig;
    if (typeof redirectConfig !== "object" || redirectConfig === null) return false;
    return (redirectConfig as Record<string, unknown>).Protocol === "HTTPS";
  });
}

export function checkAlbHttpRedirect(ctx: PostSynthContext): PostSynthDiagnostic[] {
  const diagnostics: PostSynthDiagnostic[] = [];
  const severity = isFullTierEnv(ctx.env) ? "error" : "warning";

  for (const [_lexicon, output] of ctx.outputs) {
    const template = parseCFTemplate(output);
    if (!template?.Resources) continue;

    for (const [logicalId, resource] of Object.entries(template.Resources)) {
      if (resource.Type !== "AWS::ElasticLoadBalancingV2::Listener") continue;

      const props = resource.Properties ?? {};
      const protocol = props.Protocol;
      if (isIntrinsic(protocol) || protocol !== "HTTP") continue;

      if (!redirectsToHttps(props.DefaultActions)) {
        diagnostics.push({
          checkId: "WAW044",
          severity,
          message: `Listener "${logicalId}" is HTTP and does not redirect to HTTPS — add a redirect DefaultAction (Protocol: HTTPS) on the full/production tier`,
          entity: logicalId,
          lexicon: "aws",
        });
      }
    }
  }

  return diagnostics;
}

export const waw044: PostSynthCheck = {
  id: "WAW044",
  description: "ALB HTTP listener does not redirect to HTTPS (full tier)",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return checkAlbHttpRedirect(ctx);
  },
};
