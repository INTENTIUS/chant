/**
 * DWDC011: a temporal window must fit inside the schema's `max_window`
 *
 * `formerly within 48h` under a 24h cap is an upstream validation error —
 * "temporal window `48h` exceeds the maximum allowed window `24h` set by the
 * event schema's `max_window`" — and it is arithmetic, so it needs no binary.
 *
 * Unlike DWDC010 this fires with no `.dwschema` emitted, because the cap
 * applies either way: `ServiceSchema::defaults()` caps look-back at 24h, and
 * so does an emitted schema that omits the directive. Where several schemas
 * are emitted the tightest cap wins — a window one consumer accepts and
 * another rejects is still a window that will be rejected.
 *
 * Macro-call intervals count. `once(48h, …)` expands to `formerly within 48h`
 * through the default library's `within ?w`, so it looks back exactly as far.
 */
import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import {
  dogwoodPolicyFiles,
  dogwoodSchemaFiles,
  effectiveMaxWindowSeconds,
  readEventSchema,
  scanWindows,
} from "../../dogwood/scan";

export const dwdc011: PostSynthCheck = {
  id: "DWDC011",
  description: "A dogwood temporal window stays inside the event schema's max_window cap",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const policyFiles = dogwoodPolicyFiles(ctx);
    if (policyFiles.length === 0) return [];

    const schemas = dogwoodSchemaFiles(ctx).map((s) => readEventSchema(s.text));
    const cap = effectiveMaxWindowSeconds(schemas);
    const source =
      schemas.length === 0
        ? "upstream's default cap (no event schema was emitted)"
        : `the emitted event schema's max_window`;

    const diagnostics: PostSynthDiagnostic[] = [];

    for (const policies of policyFiles) {
      const reported = new Set<string>();
      for (const window of scanWindows(policies.text)) {
        if (window.seconds <= cap.seconds) continue;
        if (reported.has(window.text)) continue;
        reported.add(window.text);
        diagnostics.push({
          checkId: "DWDC011",
          severity: "error",
          message: `Dogwood policy set "${policies.source}" looks back ${window.text}, past the ${cap.text} allowed by ${source}. Raise max_window in the event schema, or shorten the window.`,
          entity: policies.source,
          lexicon: policies.lexicon,
        });
      }
    }

    return diagnostics;
  },
};
