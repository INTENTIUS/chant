/**
 * TF044: a Terragrunt config keeps state in a local backend.
 *
 * Read from `remote_state { backend = "local" }` and from a `generate` block
 * whose `contents` declare `backend "local"`. State on the runner's disk is
 * gone when the job ends, a second job cannot read what the first applied, and
 * a git-range run, which checks out each side in a temporary directory, never
 * sees state at all. A shared backend (S3, GCS, azurerm, a Terraform HTTP
 * backend) holds it.
 *
 * A backend named by an expression is not determined and passes. A local
 * backend is sometimes right for a throwaway sandbox; suppress the rule there
 * with `# chant-ignore TF044`.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { TERRAGRUNT_GENERATE_TYPE, TERRAGRUNT_REMOTE_STATE_TYPE } from "../../hcl/parse";
import { terragruntEntities } from "./terragrunt";

const LOCAL_BACKEND_BLOCK = /\bbackend\s+"local"/;

export const tf044: PostSynthCheck = {
  id: "TF044",
  description: "Terragrunt config keeps state in a local backend",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];
    const report = (key: string, file: string, how: string): void => {
      diagnostics.push({
        checkId: "TF044",
        severity: "warning",
        message:
          `${how} in ${file} keeps state in a local backend. The state lives on the runner's disk, so a later job cannot read it ` +
          "and a git-range run, which checks out each side in a temporary directory, never sees it. Use a shared backend such as S3 or GCS.",
        entity: key,
        lexicon: "terraform",
      });
    };

    for (const block of terragruntEntities(ctx.entities, TERRAGRUNT_REMOTE_STATE_TYPE)) {
      if (block.body.backend === "local") report(block.key, block.file, "`remote_state` sets `backend = \"local\"`");
    }
    for (const block of terragruntEntities(ctx.entities, TERRAGRUNT_GENERATE_TYPE)) {
      const contents = block.body.contents;
      if (typeof contents === "string" && LOCAL_BACKEND_BLOCK.test(contents)) {
        report(block.key, block.file, `\`generate "${block.address.replace(/^generate\./, "")}"\` writes a \`backend "local"\` block`);
      }
    }
    return diagnostics;
  },
};
