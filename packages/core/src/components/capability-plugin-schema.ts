/**
 * Zod schema + validation for `CapabilityManifest` (./capability-plugin.ts) —
 * the capability-side analogue of ../lexicon-schema.ts's
 * `LexiconManifestSchema`/`validateManifest`. Used to detect a malformed
 * capability package's manifest (#559 acceptance criteria: "Doctor/validation
 * covers a malformed capability package") with the same descriptive-error
 * shape lexicon manifest validation uses.
 */

import { z } from "zod";
import type { CapabilityManifest } from "./capability-plugin";

const semverRegex = /^\d+\.\d+\.\d+(-[a-zA-Z0-9.]+)?(\+[a-zA-Z0-9.]+)?$/;

export const CapabilityManifestSchema = z.object({
  name: z.string().min(1, "manifest name must not be empty"),
  version: z.string().regex(semverRegex, "version must be valid semver (X.Y.Z)"),
  chantVersion: z.string().optional(),
  kinds: z.array(z.string().min(1)).optional(),
});

export type CapabilityManifestParsed = z.infer<typeof CapabilityManifestSchema>;

/**
 * Validate a capability manifest from unknown input (object or JSON string).
 * Throws a descriptive error on invalid input — mirrors
 * ../lexicon-schema.ts's `validateManifest`.
 */
export function validateCapabilityManifest(data: unknown): CapabilityManifest {
  if (data === null || data === undefined) {
    throw new Error("capability manifest data is empty");
  }

  if (typeof data === "string") {
    try {
      data = JSON.parse(data);
    } catch (err) {
      const msg = err instanceof SyntaxError ? err.message : String(err);
      throw new Error(`invalid JSON in capability manifest: ${msg}`);
    }
  }

  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new Error("capability manifest must be a JSON object");
  }

  const result = CapabilityManifestSchema.safeParse(data);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue.path.length > 0 ? issue.path.join(".") : undefined;
    const prefix = path ? `capability manifest field ${path}` : "capability manifest";
    throw new Error(`${prefix}: ${issue.message}`);
  }

  return result.data as CapabilityManifest;
}
