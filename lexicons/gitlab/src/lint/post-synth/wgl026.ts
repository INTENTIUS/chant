/**
 * WGL026: Privileged Services Without TLS
 *
 * Warns about Docker-in-Docker (DinD) services that don't set
 * DOCKER_TLS_CERTDIR. Running DinD without TLS exposes the Docker
 * daemon on an unencrypted socket.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { isPropertyDeclarable } from "@intentius/chant/declarable";

const DIND_IMAGES = ["docker:dind", "docker:stable-dind"];

function isDindImage(image: string): boolean {
  return DIND_IMAGES.some((dind) => image.includes(dind));
}

export const wgl026: PostSynthCheck = {
  id: "WGL026",
  description: "Privileged services without TLS — DinD services without DOCKER_TLS_CERTDIR",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [entityName, entity] of ctx.entities) {
      if (isPropertyDeclarable(entity)) continue;
      const entityType = (entity as Record<string, unknown>).entityType as string;
      if (entityType !== "GitLab::CI::Job") continue;

      const props = (entity as Record<string, unknown>).props as Record<string, unknown> | undefined;
      if (!props?.services || !Array.isArray(props.services)) continue;

      for (const service of props.services) {
        let imageName: string | undefined;
        let serviceVars: Record<string, unknown> | undefined;

        if (typeof service === "string") {
          imageName = service;
        } else if (typeof service === "object" && service !== null) {
          const svc = service as Record<string, unknown>;
          const svcProps = (svc.props as Record<string, unknown> | undefined) ?? svc;
          imageName = svcProps.name as string | undefined;
          serviceVars = svcProps.variables as Record<string, unknown> | undefined;
        }

        if (!imageName || !isDindImage(imageName)) continue;

        // Check if DOCKER_TLS_CERTDIR is set in service variables or job variables
        const jobVars = props.variables as Record<string, unknown> | undefined;
        const hasTLS = serviceVars?.DOCKER_TLS_CERTDIR !== undefined ||
          jobVars?.DOCKER_TLS_CERTDIR !== undefined;

        if (!hasTLS) {
          diagnostics.push({
            checkId: "WGL026",
            severity: "warning",
            message: `Job "${entityName}" uses DinD service without DOCKER_TLS_CERTDIR — the Docker daemon will be unencrypted`,
            entity: entityName,
            lexicon: "gitlab",
          });
        }
      }
    }

    return diagnostics;
  },
};
