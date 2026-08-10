/**
 * DWDE010: the emitted `.dw` set validates clean under `dogwood validate`
 *
 * The CLI-gated half of the epic's validation split. Everything the DWDC walls
 * ask is answerable in TypeScript and gates unconditionally; everything else —
 * macro expansion, the temporal type checker, the Cedar body checked against
 * the action schema *through upstream's own frontend* — needs upstream's Rust
 * frontend, which ships as a binary and nothing else. No npm package, no wasm
 * build, no bindings.
 *
 * So this check has two modes and says which one it is in:
 *
 * - **Binary present.** Runs `dogwood validate --format json` over each
 *   emitted policy set and reports every finding as an error. Byte-offset
 *   labels come through as byte offsets — see `../../dogwood/cli.ts` for why
 *   they are not converted to line/column.
 * - **Binary absent.** Exactly one `info` finding naming the binary, where
 *   chant looked, and this issue. The epic's words are "an explicit,
 *   issue-linked exception, not a silent one" — a check that quietly passes
 *   when it could not run is claiming a guarantee it did not make, which is
 *   the same failure CEDE010's no-schema advisory exists to avoid.
 *
 * A run that could not be made at all — a spawn failure, an unknown flag, JSON
 * in a shape this adapter does not know — is `warning`, not `error`. Upstream
 * is a read-only squash-sync mirror with no tags and no changelog, and a flag
 * rename in a sync would otherwise fail every build that has the binary
 * installed. The adapter never reads exit 2 as "rejected" on its own for the
 * same reason: clap spends that code on usage errors too.
 */
import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import {
  DOGWOOD_BINARY_NAME,
  DOGWOOD_SEARCH_ORDER,
  findDogwoodBinary,
  formatDogwoodDiagnostic,
  runDogwoodValidate,
} from "../../dogwood/cli";
import { describeBundle, planDogwoodRuns } from "./dogwood-helpers";

export const dwde010: PostSynthCheck = {
  id: "DWDE010",
  description: "Emitted dogwood policy sets validate clean under `dogwood validate`, when the binary is available",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const plan = planDogwoodRuns(ctx);
    if (!plan.hasPolicies) return [];

    const binary = findDogwoodBinary();
    if (!binary) {
      return [
        {
          checkId: "DWDE010",
          severity: "info",
          message: `This build emitted dogwood .dw policies, but no \`${DOGWOOD_BINARY_NAME}\` binary was found, so full .dw validation did not run — the DWDC walls checked what TypeScript can answer and nothing checked macro expansion, the temporal type check, or the Cedar body against the action schema. chant looked at ${DOGWOOD_SEARCH_ORDER}. See chant #1659.`,
          lexicon: plan.lexicon,
        },
      ];
    }

    if (plan.blocked) {
      return [
        {
          checkId: "DWDE010",
          severity: "info",
          message: `This build emitted dogwood .dw policies and \`${DOGWOOD_BINARY_NAME}\` is available, but ${plan.blocked}, so full .dw validation did not run. See chant #1659.`,
          lexicon: plan.lexicon,
        },
      ];
    }

    const diagnostics: PostSynthDiagnostic[] = [];

    for (const prepared of plan.bundles) {
      const where = describeBundle(prepared);
      const result = runDogwoodValidate(binary.path, prepared.bundle);

      if (result.kind === "unusable") {
        diagnostics.push({
          checkId: "DWDE010",
          severity: "warning",
          message: `Dogwood policy set ${where} could not be validated — ${result.reason}. The policy set was neither accepted nor rejected.`,
          entity: prepared.source,
          lexicon: prepared.lexicon,
        });
        continue;
      }

      if (result.kind === "fatal") {
        for (const finding of [result.error, ...result.related]) {
          diagnostics.push({
            checkId: "DWDE010",
            severity: "error",
            message: `Dogwood policy set ${where} could not be parsed or lowered: ${formatDogwoodDiagnostic(finding)}`,
            entity: prepared.source,
            lexicon: prepared.lexicon,
          });
        }
        continue;
      }

      if (result.kind === "rejected") {
        for (const finding of result.errors) {
          diagnostics.push({
            checkId: "DWDE010",
            severity: "error",
            message: `Dogwood policy set ${where} fails \`dogwood validate\`: ${formatDogwoodDiagnostic(finding)}`,
            entity: prepared.source,
            lexicon: prepared.lexicon,
          });
        }
      }

      // Upstream's own warnings ride along at warning severity. They do not
      // fail `dogwood validate` (`passed` ignores them), and they should not
      // fail a build either — but dropping them would throw away the half of
      // the report that says a policy is legal and pointless.
      for (const finding of result.warnings) {
        diagnostics.push({
          checkId: "DWDE010",
          severity: "warning",
          message: `Dogwood policy set ${where} draws a \`dogwood validate\` warning: ${formatDogwoodDiagnostic(finding)}`,
          entity: prepared.source,
          lexicon: prepared.lexicon,
        });
      }
    }

    return diagnostics;
  },
};
