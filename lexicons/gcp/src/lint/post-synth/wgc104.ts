/**
 * WGC104: Missing uniform bucket-level access
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { parseYAML } from "@intentius/chant/yaml";

export const wgc104: PostSynthCheck = {
  id: "WGC104",
  description: "StorageBucket without uniformBucketLevelAccess enabled",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [_lexicon, output] of ctx.outputs) {
      if (typeof output !== "string") continue;

      const documents = output.split(/^---\s*$/m).filter((d) => d.trim().length > 0);

      for (const docStr of documents) {
        const doc = parseYAML(docStr) as Record<string, unknown> | null;
        if (!doc || doc.kind !== "StorageBucket") continue;

        const metadata = doc.metadata as Record<string, unknown> | undefined;
        const spec = doc.spec as Record<string, unknown> | undefined;
        const name = (metadata?.name as string) ?? "unknown";

        if (spec && spec.uniformBucketLevelAccess !== true) {
          diagnostics.push({
            checkId: "WGC104",
            severity: "warning",
            message: `StorageBucket "${name}" does not have uniformBucketLevelAccess enabled — recommended for consistent access control`,
            entity: name,
            lexicon: "gcp",
          });
        }
      }
    }

    return diagnostics;
  },
};
