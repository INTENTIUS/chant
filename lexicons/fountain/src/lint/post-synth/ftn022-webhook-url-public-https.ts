import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { propsOf } from "../../entity-props";

/**
 * FTN022: a Webhook url must be https and must not point inside a network.
 *
 * fountain refuses these at create and again at delivery, so the rule is not
 * the enforcement — it is the review. A webhook is where an estate's events
 * leave it, and the two ways that goes wrong are worth catching in a diff
 * rather than in a 422: plaintext http puts turn payloads on the wire in the
 * clear, and a private target turns the delivery worker into an SSRF probe of
 * whatever fountain's network can reach. 169.254.169.254 is the case that
 * matters most — the cloud metadata address is one hop from instance
 * credentials.
 */

const PRIVATE_V4 = [
  /^10\./,
  /^127\./,
  /^192\.168\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2[0-9]|3[01])\./,
  /^0\./,
];

const LOOPBACK_NAMES = new Set(["localhost", "localhost.localdomain", "ip6-localhost", "ip6-loopback"]);

/** Is this host a loopback, link-local, or RFC1918 target? */
export function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (LOOPBACK_NAMES.has(h) || h.endsWith(".localhost") || h.endsWith(".internal")) return true;
  if (h === "::1" || h === "::" || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80:")) return true;
  return PRIVATE_V4.some((re) => re.test(h));
}

export const webhookUrlPublicHttpsCheck: PostSynthCheck = {
  id: "FTN022",
  description: "Webhook url must be https and must not be a loopback or private address",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [name, entity] of ctx.entities) {
      if (entity.entityType !== "Fountain::V1::Webhook") continue;
      const url = propsOf(entity).url;
      if (typeof url !== "string" || url.length === 0) continue;

      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        diagnostics.push({
          checkId: "FTN022",
          severity: "error",
          message: `Webhook "${name}" url "${url}" is not a URL`,
          entity: name,
          lexicon: "fountain",
        });
        continue;
      }

      if (parsed.protocol !== "https:") {
        diagnostics.push({
          checkId: "FTN022",
          severity: "error",
          message:
            `Webhook "${name}" url "${url}" is ${parsed.protocol.replace(":", "")}, not https — ` +
            `turn payloads would cross the network in the clear`,
          entity: name,
          lexicon: "fountain",
        });
      }

      if (isPrivateHost(parsed.hostname)) {
        diagnostics.push({
          checkId: "FTN022",
          severity: "error",
          message:
            `Webhook "${name}" url "${url}" targets the private host "${parsed.hostname}" — ` +
            `fountain refuses loopback, link-local and RFC1918 delivery targets`,
          entity: name,
          lexicon: "fountain",
        });
      }
    }

    return diagnostics;
  },
};
