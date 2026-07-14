/**
 * WAW047: ECS Privileged Container
 *
 * Flags ECS TaskDefinition containers running with Privileged: true — the
 * container gets elevated access to the host, equivalent to root on the EC2
 * instance (and rejected outright on Fargate).
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { parseCFTemplate, getContainerDefinitions, isIntrinsic } from "./cf-refs";

export function checkEcsPrivilegedContainer(ctx: PostSynthContext): PostSynthDiagnostic[] {
  const diagnostics: PostSynthDiagnostic[] = [];

  for (const [_lexicon, output] of ctx.outputs) {
    const template = parseCFTemplate(output);
    if (!template?.Resources) continue;

    for (const [logicalId, resource] of Object.entries(template.Resources)) {
      if (resource.Type !== "AWS::ECS::TaskDefinition") continue;

      for (const container of getContainerDefinitions(resource)) {
        const privileged = container.Privileged;
        if (isIntrinsic(privileged)) continue;

        if (privileged === true) {
          const containerName = typeof container.Name === "string" ? container.Name : "<unnamed>";
          diagnostics.push({
            checkId: "WAW047",
            severity: "error",
            message: `TaskDefinition "${logicalId}" container "${containerName}" runs with Privileged: true — drop elevated host access`,
            entity: logicalId,
            lexicon: "aws",
          });
        }
      }
    }
  }

  return diagnostics;
}

export const waw047: PostSynthCheck = {
  id: "WAW047",
  description: "ECS container runs privileged — drop elevated host access",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return checkEcsPrivilegedContainer(ctx);
  },
};
