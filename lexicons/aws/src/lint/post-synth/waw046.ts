/**
 * WAW046: ECS Secret-Looking Value In Plaintext Environment
 *
 * Flags ECS TaskDefinition container `Environment` entries whose name looks
 * like a credential (password/secret/token/key/credential) — those values are
 * visible in the task definition and console. They should be passed via
 * `Secrets` (Secrets Manager / SSM Parameter Store) instead.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { parseCFTemplate, getContainerDefinitions, isIntrinsic } from "./cf-refs";

const SECRET_NAME_PATTERN = /password|secret|token|api[_-]?key|credential/i;

export function checkEcsPlaintextSecrets(ctx: PostSynthContext): PostSynthDiagnostic[] {
  const diagnostics: PostSynthDiagnostic[] = [];

  for (const [_lexicon, output] of ctx.outputs) {
    const template = parseCFTemplate(output);
    if (!template?.Resources) continue;

    for (const [logicalId, resource] of Object.entries(template.Resources)) {
      if (resource.Type !== "AWS::ECS::TaskDefinition") continue;

      for (const container of getContainerDefinitions(resource)) {
        const env = container.Environment;
        if (!Array.isArray(env)) continue;

        for (const entry of env) {
          if (typeof entry !== "object" || entry === null) continue;
          const name = (entry as Record<string, unknown>).Name;
          if (isIntrinsic(name) || typeof name !== "string") continue;

          if (SECRET_NAME_PATTERN.test(name)) {
            const containerName = typeof container.Name === "string" ? container.Name : "<unnamed>";
            diagnostics.push({
              checkId: "WAW046",
              severity: "error",
              message: `TaskDefinition "${logicalId}" container "${containerName}" passes "${name}" via plaintext Environment — use Secrets (Secrets Manager/SSM) instead`,
              entity: logicalId,
              lexicon: "aws",
            });
          }
        }
      }
    }
  }

  return diagnostics;
}

export const waw046: PostSynthCheck = {
  id: "WAW046",
  description: "ECS container passes a secret-looking value via plaintext Environment instead of Secrets",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return checkEcsPlaintextSecrets(ctx);
  },
};
