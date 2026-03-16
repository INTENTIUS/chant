/**
 * WGC103: Missing project annotation
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { parseYAML } from "@intentius/chant/yaml";

export const wgc103: PostSynthCheck = {
  id: "WGC103",
  description: "Config Connector resource without cnrm.cloud.google.com/project-id annotation",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [_lexicon, output] of ctx.outputs) {
      if (typeof output !== "string") continue;

      const documents = output.split(/^---\s*$/m).filter((d) => d.trim().length > 0);

      for (const docStr of documents) {
        const doc = parseYAML(docStr) as Record<string, unknown> | null;
        if (!doc) continue;

        const apiVersion = doc.apiVersion as string | undefined;
        if (!apiVersion?.includes("cnrm.cloud.google.com")) continue;

        const metadata = doc.metadata as Record<string, unknown> | undefined;
        const annotations = metadata?.annotations as Record<string, unknown> | undefined;
        const name = (metadata?.name as string) ?? "unknown";

        if (!annotations?.["cnrm.cloud.google.com/project-id"]) {
          diagnostics.push({
            checkId: "WGC103",
            severity: "info",
            message: `Resource "${name}" has no cnrm.cloud.google.com/project-id annotation — will use namespace default`,
            entity: name,
            lexicon: "gcp",
          });
        }
      }
    }

    return diagnostics;
  },
};
