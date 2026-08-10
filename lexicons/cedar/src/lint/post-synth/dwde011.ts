/**
 * DWDE011: the lowered Cedar body validates clean under Cedar's own validator
 *
 * The epic's stated design for the non-temporal half: chant does not
 * re-implement lowering — `dogwood lower` produces the analyzable plain-Cedar
 * form, and a reimplementation would drift — but once that form exists, Cedar's
 * own validator is the thing that judges it. The #1657 verification put all 86
 * upstream example bundles through this exact path and every one parsed and
 * validated clean in strict mode, which is what makes a finding here mean
 * something: the lowered output is genuinely plain Cedar, so a validation error
 * is the policy's, not the pipeline's.
 *
 * What this catches that DWDE010 does not is narrow but real. `dogwood
 * validate` type-checks through upstream's vendored Cedar; this runs the
 * *published* `@cedar-policy/cedar-wasm` over the same artifacts. A body that
 * upstream's pinned Cedar accepts and the Cedar the rest of chant validates
 * against rejects is exactly the drift the pin exists to make visible — and the
 * augmented schema, with its hoisted `context.*` temporal slots, is the form a
 * downstream Cedar policy store will actually receive.
 *
 * The cedar-wasm traps from #1648 all apply and are handled in
 * `./wasm-helpers.ts`: `type: "success"` means validation *ran*, not that it
 * passed; `validationErrors` comes back in a different order almost every call
 * and is sorted before anything reads it; a malformed call throws rather than
 * returning a failure answer.
 *
 * Silent when `lower` did not run — the binary is absent, or no action schema
 * was emitted. Both cases are DWDE010's advisory to report, once, rather than
 * twice in different words.
 */
import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { findDogwoodBinary, runDogwoodLower } from "../../dogwood/cli";
import { describeBundle, planDogwoodRuns } from "./dogwood-helpers";
import { loadWasm, validatePolicySet } from "./wasm-helpers";

export const dwde011: PostSynthCheck = {
  id: "DWDE011",
  description: "The Cedar `dogwood lower` produces validates clean against the augmented schema (cedar-wasm validate)",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const plan = planDogwoodRuns(ctx);
    if (!plan.hasPolicies || plan.blocked || plan.bundles.length === 0) return [];

    const binary = findDogwoodBinary();
    if (!binary) return [];

    // A missing validator is not this check's finding to report; the cedar leg
    // says so already through CEDC010.
    const wasm = loadWasm();
    if (!wasm) return [];

    const diagnostics: PostSynthDiagnostic[] = [];

    for (const prepared of plan.bundles) {
      const where = describeBundle(prepared);
      const lowered = runDogwoodLower(binary.path, prepared.bundle);

      if (lowered.kind === "unusable") {
        diagnostics.push({
          checkId: "DWDE011",
          severity: "warning",
          message: `Dogwood policy set ${where} could not be lowered to Cedar — ${lowered.reason}. Its non-temporal body was not checked by Cedar's validator.`,
          entity: prepared.source,
          lexicon: prepared.lexicon,
        });
        continue;
      }

      if (lowered.kind === "fatal") {
        // The same fatal DWDE010 reports from its own run. Saying it twice
        // helps nobody, so this arm stays quiet and lets the validate leg own
        // the parse/lower channel.
        continue;
      }

      const { cedarPolicies, cedarSchema } = lowered.value;

      // The lowered policies go in as Cedar text. cedar-wasm synthesizes ids
      // (`policy0`, `policy1`) for a bare-string set and does not read `@id`
      // annotations as ids (#1648), so a finding names the .dw file it came
      // from as well as the id the validator used.
      const outcome = validatePolicySet(wasm, { staticPolicies: cedarPolicies }, cedarSchema);

      if (outcome.failure) {
        diagnostics.push({
          checkId: "DWDE011",
          severity: "error",
          message: `The Cedar lowered from dogwood policy set ${where} could not be validated: ${outcome.failure}`,
          entity: prepared.source,
          lexicon: prepared.lexicon,
        });
        continue;
      }

      for (const finding of outcome.errors) {
        diagnostics.push({
          checkId: "DWDE011",
          severity: "error",
          message: `The Cedar lowered from dogwood policy set ${where} fails Cedar validation (lowered policy "${finding.policyId}"): ${finding.message}`,
          entity: prepared.source,
          lexicon: prepared.lexicon,
        });
      }
    }

    return diagnostics;
  },
};
