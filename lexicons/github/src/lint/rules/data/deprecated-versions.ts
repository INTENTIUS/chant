/**
 * Deprecated action versions and recommended replacements.
 */

import { ACTION_PINS } from "../../../action-pins";

export const deprecatedVersions: Record<string, { deprecated: string[]; recommended: string }> = {
  // v4 runs on Node 20, which GitHub has deprecated for actions.
  "actions/checkout": { deprecated: ["v1", "v2", "v3", "v4"], recommended: ACTION_PINS["actions/checkout"].major },
  "actions/setup-node": { deprecated: ["v1", "v2", "v3", "v4"], recommended: ACTION_PINS["actions/setup-node"].major },
  "actions/setup-go": { deprecated: ["v1", "v2", "v3", "v4"], recommended: "v5" },
  "actions/setup-python": { deprecated: ["v1", "v2", "v3", "v4"], recommended: "v5" },
  "actions/cache": { deprecated: ["v1", "v2", "v3"], recommended: "v4" },
  "actions/upload-artifact": { deprecated: ["v1", "v2", "v3"], recommended: "v4" },
  "actions/download-artifact": { deprecated: ["v1", "v2", "v3"], recommended: "v4" },
};
