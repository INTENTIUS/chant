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
import type { DashboardItem } from "./panels";
import type { VariableEntity } from "./variables";
import type { DashboardLink, TimePickerConfig } from "./schema/dashboard.gen";
import { isFolderEntity, type FolderEntity } from "./folder";
import type { AnnotationInput } from "./annotations";

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
  /**
   * Panels and rows, top to bottom. A row's own `panels` follow it. A
   * `LibraryPanel` here is placed like a panel; a `LibraryPanelRef` places one
   * with its own `gridPos`, `id` and `title`.
   */
  panels?: DashboardItem[];
  links?: DashboardLinkInput[];
  /**
   * Annotation queries: events drawn on the dashboard's time series panels
   * (deploys, incidents), each from a datasource. Grafana adds its own
   * "Annotations & Alerts" query to every dashboard that has none with
   * `builtIn: 1`, so leave that one out unless you change it.
   */
  annotations?: AnnotationInput[];
  /**
   * The Grafana folder: a path (`"Platform/Kubernetes"`) or a `Folder`,
   * which pins the folder's uid. Written as a subdirectory of `dashboards/`,
   * which the provider maps to folders (`foldersFromFilesStructure`); a path
   * nests one directory in another, which Grafana 13.1 and later make a
   * Kubernetes folder inside Platform, and earlier versions use only the
   * last level (GRAF109 warns). The API applier creates each level with its
   * uid. Leave it out for the General folder.
   */
  folder?: string | FolderEntity;
}

/** A dashboard's props as the entity holds them: `folder` is always the path, and a `Folder` given for it is `folderEntity`. */
export type DashboardEntityProps = Omit<DashboardProps, "folder"> & { folder?: string };

export interface DashboardEntity extends Declarable {
  readonly props: DashboardEntityProps;
  /** The `Folder` the dashboard was given, when it was given one rather than a path. */
  readonly folderEntity?: FolderEntity;
}

export const DASHBOARD_TYPE = "Grafana::Dashboard";

const DashboardBase = createResource(DASHBOARD_TYPE, "grafana", {}) as unknown as (this: object, props: Record<string, unknown>) => void;

/**
 * A Grafana dashboard. A `Folder` given as its `folder` is held as the
 * folder's path, so everything that reads the dashboard's props (the build,
 * the checks, observation's diff) sees one form; the `Folder` itself, for its
 * uid, is `folderEntity`.
 */
export const Dashboard = function (this: object, props: DashboardProps) {
  const folder = props.folder;
  if (isFolderEntity(folder)) {
    DashboardBase.call(this, { ...props, folder: folder.path } as unknown as Record<string, unknown>);
    Object.defineProperty(this, "folderEntity", { value: folder, enumerable: false });
    return;
  }
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
  /**
   * Put every dashboard this provider loads in this folder: a title, or a
   * root-level `Folder`, whose title and uid are written as `folder` and
   * `folderUid` (Grafana creates a provider's folder at the root, so a
   * nested `Folder` is refused). Setting it (or `folderUid`) turns
   * `foldersFromFilesStructure` off by default, so each dashboard's own
   * `folder` is ignored (GRAF109 warns).
   */
  folder?: string | FolderEntity;
  folderUid?: string;
  /** Where the `dashboards/` output is mounted in the Grafana container. Defaults to `/var/lib/grafana/dashboards`. */
  path?: string;
  /** Map subdirectories to Grafana folders. Defaults to true, which is what a dashboard's `folder` relies on. */
  foldersFromFilesStructure?: boolean;
  disableDeletion?: boolean;
  allowUiUpdates?: boolean;
  updateIntervalSeconds?: number;
}

/** A provider's props as the entity holds them: a `Folder` given for `folder` is written out as `folder` and `folderUid`. */
export type DashboardProviderEntityProps = Omit<DashboardProviderProps, "folder"> & { folder?: string };

export interface DashboardProviderEntity extends Declarable {
  readonly props: DashboardProviderEntityProps;
}

export const DASHBOARD_PROVIDER_TYPE = "Grafana::DashboardProvider";

const ProviderBase = createResource(DASHBOARD_PROVIDER_TYPE, "grafana", {}) as unknown as (
  this: object,
  props: Record<string, unknown>,
) => void;

/** An entry in the dashboard provisioning file. Optional: a default one is written when none is declared. */
export const DashboardProvider = function (this: object, props: DashboardProviderProps) {
  const folder = props.folder;
  if (isFolderEntity(folder)) {
    if (folder.props.parent) {
      throw new Error(
        `grafana: DashboardProvider "${props.name}" puts its dashboards in the Folder "${folder.path}", which is nested; Grafana creates a provider's folder at the root. Give it a root-level Folder, or leave folder out and set each dashboard's folder`,
      );
    }
    if (props.folderUid !== undefined && props.folderUid !== folder.uid) {
      throw new Error(`grafana: DashboardProvider "${props.name}" has folderUid "${props.folderUid}", but its Folder's uid is "${folder.uid}"`);
    }
    ProviderBase.call(this, { ...props, folder: folder.props.title, folderUid: folder.uid } as unknown as Record<string, unknown>);
    return;
  }
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
