/**
 * The Grafana RBAC actions chant's live paths call, for a custom role on the
 * service account whose token a `grafana.profiles.<env>` entry names. The
 * basic Editor role covers all of them; these are for a narrower role.
 *
 * - `Observe`: `chant lifecycle diff --live` and `chant import --from`
 *   (#2946), which read dashboards, folders and datasources.
 * - `Apply`: the API applier (#2948), which also reads what it writes to
 *   compare, and writes folders, library panels and dashboards.
 * - `Prune`: the applier with `prune`, which deletes dashboards and folders
 *   (never library panels or datasources).
 *
 * Grant them on `folders:*` and `dashboards:*` scopes, or on the folders
 * chant writes to.
 */
export const GrafanaActions = {
  Observe: ["dashboards:read", "folders:read", "datasources:read"],
  Apply: [
    "dashboards:read",
    "dashboards:create",
    "dashboards:write",
    "folders:read",
    "folders:create",
    "folders:write",
    "library.panels:read",
    "library.panels:create",
    "library.panels:write",
  ],
  Prune: ["dashboards:read", "dashboards:delete", "folders:read", "folders:delete"],
} as const;

export type GrafanaAccessLevel = keyof typeof GrafanaActions;

// A Map-backed lookup, so evaluable code avoids computed element access (EVL003).
const GRAFANA_ACTIONS = new Map<GrafanaAccessLevel, readonly string[]>(Object.entries(GrafanaActions) as [GrafanaAccessLevel, readonly string[]][]);

/** The actions for one or more access levels, deduplicated, in first-seen order. */
export function grafanaActionsFor(...levels: GrafanaAccessLevel[]): string[] {
  return [...new Set(levels.flatMap((l) => GRAFANA_ACTIONS.get(l) ?? []))];
}
