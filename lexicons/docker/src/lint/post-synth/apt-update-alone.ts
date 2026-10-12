/**
 * DKRD020: apt-get update in its own RUN
 *
 * A RUN that only runs `apt-get update` is cached as its own layer, so a
 * later `apt-get install` in another RUN can install from a stale package
 * index. Update and install in the same RUN.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { commandText, eachDockerfile, stageLabel } from "./docker-helpers";

const UPDATE = /\bapt(-get)?\s+update\b/;
const INSTALL = /\bapt(-get)?\s+(install|upgrade|dist-upgrade)\b/;

export const dkrd020: PostSynthCheck = {
  id: "DKRD020",
  description: "apt-get update in a different RUN from apt-get install — the install can use a stale package index",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const { fileName, parsed } of eachDockerfile(ctx.outputs)) {
      for (const stage of parsed.stages) {
        const runs = stage.instructions.filter((i) => i.instruction === "RUN");
        const updateAt = runs.findIndex((r) => UPDATE.test(commandText(r)) && !INSTALL.test(commandText(r)));
        if (updateAt === -1) continue;
        if (!runs.slice(updateAt + 1).some((r) => INSTALL.test(commandText(r)))) continue;
        diagnostics.push({
          checkId: "DKRD020",
          severity: "warning",
          message: `${fileName} ${stageLabel(stage)}: apt-get update runs in its own RUN, and a later RUN installs from that cached index. Run update and install in one RUN: apt-get update && apt-get install -y --no-install-recommends ...`,
          lexicon: "docker",
        });
      }
    }

    return diagnostics;
  },
};
