/**
 * DKRD014: Root-only command after a non-root USER
 *
 * A RUN that installs packages or manages users and ownership (apt-get,
 * apk add, useradd, chown, ...) fails or misbehaves after USER switches to
 * an unprivileged user. Run root setup first, then switch USER.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { commandText, eachDockerfile, instrText, isRootUser, stageLabel } from "./docker-helpers";

const ROOT_ONLY = /(^|[\s;&|(])(apt-get\s+(install|update|upgrade|dist-upgrade|remove|purge)|apt\s+(install|update|upgrade)|apk\s+(add|update|upgrade|del)|yum\s+(install|update)|dnf\s+(install|update|upgrade)|microdnf\s+install|zypper\s+(install|in|refresh)|useradd|adduser|groupadd|addgroup|usermod|chown)\b/;

export const dkrd014: PostSynthCheck = {
  id: "DKRD014",
  description: "RUN needs root but comes after USER switched to a non-root user",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const { fileName, parsed } of eachDockerfile(ctx.outputs)) {
      for (const stage of parsed.stages) {
        let user: string | undefined;
        for (const instr of stage.instructions) {
          if (instr.instruction === "USER") {
            user = instr.value.trim();
            continue;
          }
          if (instr.instruction !== "RUN" || user === undefined || isRootUser(user)) continue;
          const cmd = commandText(instr);
          if (/\bsudo\b/.test(cmd) || !ROOT_ONLY.test(cmd)) continue;
          diagnostics.push({
            checkId: "DKRD014",
            severity: "warning",
            message: `${fileName} ${stageLabel(stage)}: ${instrText(instr)} needs root but runs as USER ${user}. Move it before the USER step, or switch to USER root for it.`,
            lexicon: "docker",
          });
        }
      }
    }

    return diagnostics;
  },
};
