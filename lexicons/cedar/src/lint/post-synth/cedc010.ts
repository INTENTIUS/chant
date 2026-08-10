/**
 * CEDC010: the emitted policy set must parse as Cedar
 *
 * The floor every other check stands on. `policies.cedar.json` is Cedar's own
 * JSON policy format inside the `PolicySet` envelope the wasm accepts, which
 * means Cedar's own deserializer is the authority on whether it is well formed
 * — not a hand-written shape test. A set that does not parse cannot be loaded
 * by any evaluator (AVP, cedar-agent, an embedded `cedar-wasm`), so this is an
 * error everywhere, in every environment.
 *
 * Two failure modes reach here: the file is not JSON at all, and the JSON is
 * not a Cedar policy set. Both are reported against the file, since neither
 * has a single implicated policy.
 */
import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { CEDAR_LEXICON, policySets } from "./cedar-helpers";
import { loadWasm, normalizePolicySet, parsePolicySet, wasmLoadError } from "./wasm-helpers";

export const cedc010: PostSynthCheck = {
  id: "CEDC010",
  description: "The emitted Cedar policy set must parse as Cedar (checkParsePolicySet)",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];
    const sets = policySets(ctx);
    if (sets.length === 0) return diagnostics;

    const wasm = loadWasm();
    if (!wasm) {
      // The only place the missing-validator condition is reported. The other
      // wasm-backed checks stay quiet rather than repeating it four times.
      return [
        {
          checkId: "CEDC010",
          severity: "warning",
          message: `Cedar policies were emitted but @cedar-policy/cedar-wasm could not be loaded, so none of them were parsed or validated: ${wasmLoadError()}`,
          lexicon: CEDAR_LEXICON,
        },
      ];
    }

    for (const set of sets) {
      if (set.doc === undefined) {
        diagnostics.push({
          checkId: "CEDC010",
          severity: "error",
          message: `Cedar policy set "${set.source}" is not readable as JSON: ${set.parseError}`,
          entity: set.source,
          lexicon: set.lexicon,
        });
        continue;
      }

      const { policySet } = normalizePolicySet(wasm, set);
      const parsed = parsePolicySet(wasm, policySet);
      if (!parsed.ok) {
        diagnostics.push({
          checkId: "CEDC010",
          severity: "error",
          message: `Cedar policy set "${set.source}" could not be parsed: ${parsed.message}`,
          entity: set.source,
          lexicon: set.lexicon,
        });
        continue;
      }

      for (const message of parsed.value) {
        diagnostics.push({
          checkId: "CEDC010",
          severity: "error",
          message: `Cedar policy set "${set.source}" does not parse as Cedar: ${message}`,
          entity: set.source,
          lexicon: set.lexicon,
        });
      }
    }

    return diagnostics;
  },
};
