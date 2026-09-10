/**
 * AUG101: two profiles asking the same question.
 *
 * A profile is a traffic level to predict at, and the level is the whole of
 * what the request varies (`./../../request.ts` — everything else in the
 * request comes from the estate). Two profiles naming the same level are two
 * byte-identical requests, so an engine is billed twice, a delta between them
 * is guaranteed to be zero, and a reader looking at two rows with different
 * names and identical figures has no way to tell that the sameness is the
 * declaration's fault rather than the estate's.
 *
 * Reported at `error` severity, because the second request is spent money and
 * the identical rows are a misleading report rather than an untidy one. Two
 * levels that differ only in whitespace are the same level: chant does not
 * parse the string, and an engine reading `"100 rps"` and `"100  rps"` as two
 * questions is an engine nobody has.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import type { SerializerResult } from "@intentius/chant/serializer";
import { AUGUR_PROFILES_VERSION, type SerializedProfile } from "../../serializer";

/** The emitted profile documents in a build's outputs, parsed. */
export function augurProfileDocuments(ctx: PostSynthContext): Array<{ source: string; profiles: SerializedProfile[] }> {
  const docs: Array<{ source: string; profiles: SerializedProfile[] }> = [];
  for (const [outputName, output] of ctx.outputs) {
    const texts: Array<[string, string]> =
      typeof output === "string"
        ? [[outputName, output]]
        : [
            [outputName, (output as SerializerResult).primary],
            ...Object.entries((output as SerializerResult).files ?? {}),
          ];
    for (const [source, text] of texts) {
      if (!text || !text.includes(AUGUR_PROFILES_VERSION)) continue;
      try {
        const parsed = JSON.parse(text) as { profiles?: SerializedProfile[] };
        if (Array.isArray(parsed.profiles)) docs.push({ source, profiles: parsed.profiles });
      } catch {
        // not this lexicon's output
      }
    }
  }
  return docs;
}

/** Whitespace-collapsed, case-folded: the two strings an engine would read as one question. */
function levelKey(traffic: string): string {
  return traffic.trim().replace(/\s+/g, " ").toLowerCase();
}

export const aug101: PostSynthCheck = {
  id: "AUG101",
  description: "Two profiles naming the same traffic level are the same request, asked twice",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];
    for (const { source, profiles } of augurProfileDocuments(ctx)) {
      const byLevel = new Map<string, string[]>();
      for (const profile of profiles) {
        if (typeof profile.traffic !== "string" || profile.traffic.trim() === "") continue;
        const key = levelKey(profile.traffic);
        byLevel.set(key, [...(byLevel.get(key) ?? []), profile.name]);
      }
      for (const [, names] of byLevel) {
        if (names.length < 2) continue;
        const [first] = profiles.filter((p) => names.includes(p.name));
        diagnostics.push({
          checkId: "AUG101",
          severity: "error",
          message:
            `${source}: ${names.join(", ")} all name the traffic level "${first.traffic}". A profile is ` +
            "the question, and identical questions produce identical requests — the engine is asked " +
            "twice, the delta between the two answers is zero by construction, and a reader sees two " +
            "differently named rows carrying the same figures. Give them different levels, or declare one.",
          entity: names[1],
          lexicon: "augur",
        });
      }
    }
    return diagnostics;
  },
};
