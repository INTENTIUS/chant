/**
 * SLR023: Node State must be a valid initial state
 *
 * NodeName stanzas can only set the initial state to: UNKNOWN, DOWN, FUTURE,
 * CLOUD, or DRAIN. Values like "UP", "IDLE", or "ALLOCATED" are runtime states
 * that cannot be set in slurm.conf — slurmctld silently ignores them and
 * leaves the node in an unexpected state.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";

const VALID_INITIAL_STATES = new Set(["UNKNOWN", "DOWN", "FUTURE", "CLOUD", "DRAIN"]);

export const slr023: PostSynthCheck = {
  id: "SLR023",
  description: "NodeName State must be UNKNOWN, DOWN, FUTURE, CLOUD, or DRAIN",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [lexicon, output] of ctx.outputs) {
      if (lexicon !== "slurm") continue;
      const content = typeof output === "string" ? output : output.primary;

      for (const match of content.matchAll(/^NodeName=(\S+)[^\n]*\bState=(\S+)/gm)) {
        const nodeName = match[1];
        const state = match[2];

        if (!VALID_INITIAL_STATES.has(state)) {
          diagnostics.push({
            checkId: "SLR023",
            severity: "warning",
            message: `Node "${nodeName}" has invalid initial State="${state}" — valid values: ${[...VALID_INITIAL_STATES].join(", ")}`,
            entity: nodeName,
            lexicon: "slurm",
          });
        }
      }
    }

    return diagnostics;
  },
};
