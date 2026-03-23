/**
 * WAW035: Solr Container Missing nofile Ulimit
 *
 * Solr opens a file descriptor for every shard replica, index file, log, and
 * connection. Without a raised nofile limit the process hits the default kernel
 * limit (~1024) under moderate load, causing "Too many open files" errors that
 * bring the node down. The production minimum is 65535.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { parseCFTemplate } from "./cf-refs";

const NOFILE_MIN = 65535;

function isSolrImage(image: unknown): boolean {
  return typeof image === "string" && image.toLowerCase().includes("solr");
}

export function checkSolrUlimits(ctx: PostSynthContext): PostSynthDiagnostic[] {
  const diagnostics: PostSynthDiagnostic[] = [];

  for (const [_lexicon, output] of ctx.outputs) {
    const template = parseCFTemplate(output);
    if (!template?.Resources) continue;

    for (const [logicalId, resource] of Object.entries(template.Resources)) {
      if (resource.Type !== "AWS::ECS::TaskDefinition") continue;

      const containers: unknown[] = Array.isArray(resource.Properties?.ContainerDefinitions)
        ? resource.Properties.ContainerDefinitions
        : [];

      for (const container of containers) {
        if (typeof container !== "object" || container === null) continue;
        const c = container as Record<string, unknown>;

        if (!isSolrImage(c.Image)) continue;

        const ulimits: unknown[] = Array.isArray(c.Ulimits) ? c.Ulimits : [];
        const nofile = ulimits.find(
          (u): u is Record<string, unknown> =>
            typeof u === "object" && u !== null && (u as Record<string, unknown>).Name === "nofile",
        );

        const hardLimit = nofile ? Number(nofile.HardLimit ?? 0) : 0;

        if (!nofile || hardLimit < NOFILE_MIN) {
          const current = nofile ? ` (current HardLimit: ${hardLimit})` : " (not set)";
          diagnostics.push({
            checkId: "WAW035",
            severity: "warning",
            message: `Solr container "${c.Name ?? "app"}" in task "${logicalId}" nofile ulimit${current} — set HardLimit >= ${NOFILE_MIN} to prevent "Too many open files" under load`,
            entity: logicalId,
            lexicon: "aws",
          });
        }
      }
    }
  }

  return diagnostics;
}

export const waw035: PostSynthCheck = {
  id: "WAW035",
  description: "Solr container missing nofile ulimit >= 65535",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return checkSolrUlimits(ctx);
  },
};
