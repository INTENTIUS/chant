/**
 * WGC101: Missing encryption on StorageBucket or SQLInstance
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { parseYAML } from "@intentius/chant/yaml";

export const wgc101: PostSynthCheck = {
  id: "WGC101",
  description: "StorageBucket or SQLInstance without encryption configuration",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [_lexicon, output] of ctx.outputs) {
      if (typeof output !== "string") continue;

      const documents = output.split(/^---\s*$/m).filter((d) => d.trim().length > 0);

      for (const docStr of documents) {
        const doc = parseYAML(docStr) as Record<string, unknown> | null;
        if (!doc) continue;

        const kind = doc.kind as string | undefined;
        const metadata = doc.metadata as Record<string, unknown> | undefined;
        const spec = doc.spec as Record<string, unknown> | undefined;
        const name = (metadata?.name as string) ?? "unknown";

        if (kind === "StorageBucket" && spec && !spec.encryption) {
          diagnostics.push({
            checkId: "WGC101",
            severity: "warning",
            message: `StorageBucket "${name}" has no encryption configuration — consider adding spec.encryption.kmsKeyRef`,
            entity: name,
            lexicon: "gcp",
          });
        }

        if (kind === "SQLInstance" && spec) {
          const settings = spec.settings as Record<string, unknown> | undefined;
          if (!settings?.ipConfiguration || !(settings as Record<string, unknown>).backupConfiguration) {
            diagnostics.push({
              checkId: "WGC101",
              severity: "warning",
              message: `SQLInstance "${name}" may be missing encryption or backup configuration`,
              entity: name,
              lexicon: "gcp",
            });
          }
        }
      }
    }

    return diagnostics;
  },
};
