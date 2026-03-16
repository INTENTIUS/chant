/**
 * Deprecated action versions and recommended replacements.
 */

export const deprecatedVersions: Record<string, { deprecated: string[]; recommended: string }> = {
  "actions/checkout": { deprecated: ["v1", "v2", "v3"], recommended: "v4" },
  "actions/setup-node": { deprecated: ["v1", "v2", "v3"], recommended: "v4" },
  "actions/setup-go": { deprecated: ["v1", "v2", "v3", "v4"], recommended: "v5" },
  "actions/setup-python": { deprecated: ["v1", "v2", "v3", "v4"], recommended: "v5" },
  "actions/cache": { deprecated: ["v1", "v2", "v3"], recommended: "v4" },
  "actions/upload-artifact": { deprecated: ["v1", "v2", "v3"], recommended: "v4" },
  "actions/download-artifact": { deprecated: ["v1", "v2", "v3"], recommended: "v4" },
};
