/**
 * DKRD012: No Root User
 *
 * Warns when the container would run as root: the final stage has no USER
 * instruction, or its last USER is root. USER in an earlier stage does not
 * carry into the final image.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { eachDockerfile, isRootUser, stageLabel } from "./docker-helpers";

export const dkrd012: PostSynthCheck = {
  id: "DKRD012",
  description: "Dockerfile's final stage has no USER instruction, or ends on USER root — container runs as root",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const { fileName, parsed } of eachDockerfile(ctx.outputs)) {
      const final = parsed.stages[parsed.stages.length - 1];
      if (!final) continue;
      const users = final.instructions.filter((i) => i.instruction === "USER");
      const last = users[users.length - 1];
      let message: string | undefined;
      if (!last) {
        const anyUser = parsed.stages.some((s) => s.instructions.some((i) => i.instruction === "USER"));
        message = anyUser
          ? `${fileName}: The final ${stageLabel(final)} has no USER instruction; a USER in an earlier stage does not carry over. The container will run as root. Add a USER step to the final stage.`
          : `${fileName}: No USER instruction found. The container will run as root. Add a USER instruction to improve security.`;
      } else if (isRootUser(last.value)) {
        message = `${fileName}: The final ${stageLabel(final)} ends on USER ${last.value.trim()}, so the container runs as root. Switch to an unprivileged USER after the root setup steps.`;
      }
      if (message) diagnostics.push({ checkId: "DKRD012", severity: "warning", message, lexicon: "docker" });
    }

    return diagnostics;
  },
};
