/**
 * WHM503: Dead value assignment (#1252, epic #1228 Phase 7).
 *
 * A supplied value that never survives coalescing is a lie in the config:
 * it reads as if it configures something, and nothing ever sees it. The
 * coalesced-values probe (#1251, ../../values-probe.ts) knows three ways a
 * supplied value dies — shadowed by a later supplied layer, targeting a
 * dependency a `condition:` disabled, or a values map under a top-level key
 * that names no dependency at all (the silently-ignored subchart typo).
 *
 * The check reports over the probe records of the current process
 * (`getValuesProbeRecords`): whatever ran the probe — the pinned-render
 * build path, a test, a direct call — this check turns its dead assignments
 * into diagnostics. No probe run, nothing to report; the probe itself needs
 * the helm binary and the chart source, which a post-synth check must not
 * require on its own.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { getValuesProbeRecords, type DeadAssignment } from "../../values-probe";

function describe(dead: DeadAssignment): string {
  switch (dead.reason) {
    case "shadowed":
      return `supplied value "${dead.path}" (${dead.origin}) never survives coalescing — shadowed by ${dead.shadowedBy}`;
    case "disabled-subchart":
      return `supplied value "${dead.path}" (${dead.origin}) targets a disabled subchart — ${dead.shadowedBy}`;
    case "unknown-subchart":
      return `supplied values under "${dead.path}" (${dead.origin}) target no subchart — ${dead.shadowedBy}`;
  }
}

export const whm503: PostSynthCheck = {
  id: "WHM503",
  description: "Detect supplied values that never survive coalescing (shadowed, disabled subchart, unknown subchart)",

  check(_ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];
    for (const record of getValuesProbeRecords()) {
      for (const dead of record.probe.deadAssignments) {
        diagnostics.push({
          checkId: "WHM503",
          severity: "warning",
          message: describe(dead),
          entity: record.name,
          lexicon: "helm",
        });
      }
    }
    return diagnostics;
  },
};
