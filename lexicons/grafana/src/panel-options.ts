/**
 * Hand-written option types for the built-in panels that have no schema.
 *
 * The alert list and flame graph panels define their options in TypeScript
 * inside Grafana's frontend, with no CUE kind, so foundation-sdk publishes
 * no JSON Schema for them and `npm run generate` has nothing to read. The
 * types here follow Grafana's source at v13.2.2, cited per type. GRAF107
 * checks these panels' envelope (the dashboard schema's `Panel`) but not
 * their `options`; the traces panel is in the same position and keeps
 * untyped options.
 */

import type { ThresholdsConfig, ValueMapping } from "./schema/dashboard.gen";

/**
 * How the alert list orders rules: `SortOrder` in
 * public/app/plugins/panel/alertlist/types.ts:4-10 (a numeric enum starting at 1).
 * 1 alphabetical ascending, 2 descending, 3 by importance, 4 time ascending, 5 time descending.
 */
export type AlertListSortOrder = 1 | 2 | 3 | 4 | 5;

/** Which rule states the alert list shows: `StateFilter`, public/app/plugins/panel/alertlist/types.ts:22-30. */
export interface AlertListStateFilter {
  firing: boolean;
  pending: boolean;
  /** Kept for dashboards saved before 9.x. */
  inactive: boolean;
  recovering: boolean;
  noData: boolean;
  normal: boolean;
  error: boolean;
}

/**
 * The alert list panel's options: `UnifiedAlertListOptions`,
 * public/app/plugins/panel/alertlist/types.ts:32-49 at v13.2.2. Defaults are in
 * public/app/plugins/panel/alertlist/module.tsx.
 */
export interface AlertListOptions {
  maxItems: number;
  sortOrder: AlertListSortOrder;
  /** Only rules from the dashboard the panel is on. */
  dashboardAlerts: boolean;
  groupMode: "default" | "custom";
  groupBy: string[];
  alertName: string;
  showInstances: boolean;
  /** Only rules in this folder; null for any. */
  folder: { uid: string; title: string } | null;
  stateFilter: AlertListStateFilter;
  alertInstanceLabelFilter: string;
  /** The rule source's datasource name, or null for all. */
  datasource: string | null;
  viewMode: "list" | "stat";
  showInactiveAlerts: boolean;
  /** `BigValueColorMode`, packages/grafana-ui/src/components/BigValue/BigValueTypes.ts:8-13. */
  statColorMode: "background" | "background_solid" | "none" | "value";
  statThresholds: ThresholdsConfig;
  statValueMappings: ValueMapping[];
}

/** The flame graph panel's options: `Options`, public/app/plugins/panel/flamegraph/types.ts:1-3 at v13.2.2. */
export interface FlameGraphOptions {
  /** Hide the top table and show only the flame graph. */
  showFlameGraphOnly: boolean;
}
