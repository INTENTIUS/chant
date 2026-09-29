/**
 * `Dashboard` and `DashboardProvider`.
 *
 * A dashboard is written to `dashboards/<folder>/<uid>.json`, the JSON
 * Grafana imports as it is. A provider is the entry in
 * `provisioning/dashboards/chant.yaml` that points Grafana at those files;
 * a build with dashboards and no declared provider gets a default one.
 */

import { createResource } from "@intentius/chant/runtime";
import type { Declarable } from "@intentius/chant/declarable";
import type { PanelEntity, RowEntity } from "./panels";
import type { VariableEntity } from "./variables";
import type { DashboardLink, TimePickerConfig } from "./schema/dashboard.gen";

/** A dashboard link: `title` and `type` required, the rest defaulted as Grafana's editor would. */
export type DashboardLinkInput = Partial<DashboardLink> & Pick<DashboardLink, "title" | "type">;

export interface DashboardProps {
  title: string;
  /**
   * Stable id: links, provisioning and the API address a dashboard by it.
   * Letters, digits, `-` and `_`, at most 40 characters. Defaults to the
   * export name as a uid (`checkoutService` becomes `checkout-service`).
   */
  uid?: string;
  description?: string;
  tags?: string[];
  /** Initial time range. Defaults to the last 6 hours. */
  time?: { from: string; to: string };
  /** Auto-refresh interval, e.g. `30s`. */
  refresh?: string;
  /** `browser`, `utc` or an IANA zone. Defaults to `browser`. */
  timezone?: string;
  weekStart?: string;
  fiscalYearStartMonth?: number;
  liveNow?: boolean;
  timepicker?: TimePickerConfig;
  /** Shared crosshair or tooltip across panels. */
  graphTooltip?: "default" | "sharedCrosshair" | "sharedTooltip";
  /** Whether users may edit it in the UI. Defaults to true, as in Grafana. */
  editable?: boolean;
  /**
   * The dashboard schema version the JSON is written at. Leave it out for
   * the pinned one (`DASHBOARD_SCHEMA_VERSION`). `chant import` sets it for
   * a dashboard saved by an older Grafana, so Grafana still runs its
   * migrations when it loads the rebuilt JSON.
   */
  schemaVersion?: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  variables?: VariableEntity<any>[];
  /** Panels and rows, top to bottom. A row's own `panels` follow it. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  panels?: Array<PanelEntity<any, any> | RowEntity>;
  links?: DashboardLinkInput[];
  /**
   * The Grafana folder to provision it into. Written as a subdirectory of
   * `dashboards/`, which the provider maps to folders
   * (`foldersFromFilesStructure`). Leave it out for the General folder.
   */
  folder?: string;
}

export interface DashboardEntity extends Declarable {
  readonly props: DashboardProps;
}

export const DASHBOARD_TYPE = "Grafana::Dashboard";

const DashboardBase = createResource(DASHBOARD_TYPE, "grafana", {}) as unknown as (this: object, props: Record<string, unknown>) => void;

/** A Grafana dashboard. */
export const Dashboard = function (this: object, props: DashboardProps) {
  DashboardBase.call(this, props as unknown as Record<string, unknown>);
} as unknown as new (props: DashboardProps) => DashboardEntity;
Object.defineProperty(Dashboard, "name", { value: "Dashboard" });

export function isDashboardEntity(value: unknown): value is DashboardEntity {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Declarable).entityType === DASHBOARD_TYPE &&
    (value as Declarable).lexicon === "grafana"
  );
}

/** Where Grafana finds the dashboard files by default: mount `dashboards/` here. */
export const DEFAULT_DASHBOARDS_PATH = "/var/lib/grafana/dashboards";

export interface DashboardProviderProps {
  /** Provider name, unique in the provisioning file. */
  name: string;
  orgId?: number;
  /** Folder for dashboards not in a subdirectory. */
  folder?: string;
  folderUid?: string;
  /** Where the `dashboards/` output is mounted in the Grafana container. Defaults to `/var/lib/grafana/dashboards`. */
  path?: string;
  /** Map subdirectories to Grafana folders. Defaults to true, which is what a dashboard's `folder` relies on. */
  foldersFromFilesStructure?: boolean;
  disableDeletion?: boolean;
  allowUiUpdates?: boolean;
  updateIntervalSeconds?: number;
}

export interface DashboardProviderEntity extends Declarable {
  readonly props: DashboardProviderProps;
}

export const DASHBOARD_PROVIDER_TYPE = "Grafana::DashboardProvider";

const ProviderBase = createResource(DASHBOARD_PROVIDER_TYPE, "grafana", {}) as unknown as (
  this: object,
  props: Record<string, unknown>,
) => void;

/** An entry in the dashboard provisioning file. Optional: a default one is written when none is declared. */
export const DashboardProvider = function (this: object, props: DashboardProviderProps) {
  ProviderBase.call(this, props as unknown as Record<string, unknown>);
} as unknown as new (props: DashboardProviderProps) => DashboardProviderEntity;
Object.defineProperty(DashboardProvider, "name", { value: "DashboardProvider" });

export function isDashboardProviderEntity(value: unknown): value is DashboardProviderEntity {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Declarable).entityType === DASHBOARD_PROVIDER_TYPE &&
    (value as Declarable).lexicon === "grafana"
  );
}
