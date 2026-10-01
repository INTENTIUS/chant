/**
 * `LibraryPanel` and `LibraryPanelRef`: a panel kept in Grafana's library and
 * shared by dashboards (#3010).
 *
 * A dashboard that uses a library panel holds only a reference to it,
 * `{ id, gridPos, libraryPanel: { uid, name } }`; Grafana draws the panel
 * from the library's copy. A `LibraryPanel` declares that copy: its uid, its
 * name in the library, its folder and the panel itself. The build writes it
 * into the `__elements` of every dashboard that uses it, keyed by uid, the
 * way "Export for sharing externally" does:
 *
 * - The API applier (./api/apply.ts) writes each one to
 *   `/api/library-elements` before the dashboards, in its `folder`, or in
 *   the folder of the first dashboard that carries it when it has none.
 * - Grafana's import (Dashboards > New > Import, `/api/dashboards/import`)
 *   creates the library panels a file's `__elements` carries.
 * - File provisioning does not: Grafana stores the dashboard with its
 *   `__elements` and draws the reference only once a library panel with
 *   that uid exists (checked against Grafana 12.4.11 and 13.2.2).
 *
 * A dashboard places a library panel by listing it in `panels`, where it is
 * laid out like any panel at its panel's default size, or with a
 * `LibraryPanelRef`, which sets the reference's `gridPos`, `id` and `title`.
 * A `LibraryPanelRef` can also name a library panel the project does not
 * declare, by `{ uid, name }`: one that already exists in Grafana, which the
 * build references and never writes.
 */

import { createProperty, createResource } from "@intentius/chant/runtime";
import type { Declarable } from "@intentius/chant/declarable";
import type { GridPos } from "./schema/dashboard.gen";
import type { PanelEntity } from "./panels";
import { isFolderEntity, type FolderEntity } from "./folder";
import { slugUid } from "./util";

export interface LibraryPanelProps {
  /** The name Grafana's library lists it under. Dashboards' references carry it too. */
  name: string;
  /**
   * Stable id, which every reference names: letters, digits, `-` and `_`, at
   * most 40 characters. Defaults to the name as a uid (`Burn rate` becomes
   * `burn-rate`).
   */
  uid?: string;
  /**
   * The folder the library panel is kept in: a path (`"Platform/SLOs"`) or a
   * `Folder`. Leave it out to keep it in the folder of the first dashboard
   * that uses it, as Grafana's import does.
   */
  folder?: string | FolderEntity;
  /** The panel itself. Its `gridPos` and `id` are not part of it: each reference has its own. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  panel: PanelEntity<any, any>;
}

/** A library panel's props as the entity holds them: `folder` is always the path, and a `Folder` given for it is `folderEntity`. */
export type LibraryPanelEntityProps = Omit<LibraryPanelProps, "folder"> & { folder?: string };

export interface LibraryPanelEntity extends Declarable {
  readonly props: LibraryPanelEntityProps;
  /** Its uid: its own, else one made from its name. */
  readonly uid: string;
  /** The `Folder` it was given, when it was given one rather than a path. */
  readonly folderEntity?: FolderEntity;
}

export const LIBRARY_PANEL_TYPE = "Grafana::LibraryPanel";

const LibraryPanelBase = createResource(LIBRARY_PANEL_TYPE, "grafana", {}) as unknown as (this: object, props: Record<string, unknown>) => void;

/** A panel kept in Grafana's library, which dashboards place with a reference. */
export const LibraryPanel = function (this: object, props: LibraryPanelProps) {
  if (typeof props.name !== "string" || props.name.trim() === "") throw new Error("grafana: a LibraryPanel needs a name");
  const folder = props.folder;
  if (isFolderEntity(folder)) {
    LibraryPanelBase.call(this, { ...props, folder: folder.path } as unknown as Record<string, unknown>);
    Object.defineProperty(this, "folderEntity", { value: folder, enumerable: false });
  } else {
    LibraryPanelBase.call(this, props as unknown as Record<string, unknown>);
  }
  Object.defineProperty(this, "uid", { value: props.uid ?? slugUid(props.name), enumerable: false });
} as unknown as new (props: LibraryPanelProps) => LibraryPanelEntity;
Object.defineProperty(LibraryPanel, "name", { value: "LibraryPanel" });

export function isLibraryPanelEntity(value: unknown): value is LibraryPanelEntity {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Declarable).entityType === LIBRARY_PANEL_TYPE &&
    (value as Declarable).lexicon === "grafana"
  );
}

/** A library panel's uid from its props, as observation sees them. */
export function libraryPanelUidOf(props: Record<string, unknown>): string | undefined {
  if (typeof props.uid === "string" && props.uid !== "") return props.uid;
  return typeof props.name === "string" && props.name !== "" ? slugUid(props.name) : undefined;
}

// ── References ──────────────────────────────────────────────────

/** A library panel by uid and name: one that exists in Grafana, outside the project. */
export interface ExternalLibraryPanel {
  uid: string;
  name: string;
}

export interface LibraryPanelRefProps {
  /** The library panel: a `LibraryPanel`, or `{ uid, name }` for one that already exists in Grafana. */
  libraryPanel: LibraryPanelEntity | ExternalLibraryPanel;
  /** Position and size in the 24-column grid, as for any panel. */
  gridPos?: Partial<GridPos>;
  /** Panel id within the dashboard. Defaults to position order. */
  id?: number;
  /** The title the reference carries. Grafana shows the library panel's own. */
  title?: string;
}

export interface LibraryPanelRefEntity extends Declarable {
  readonly props: LibraryPanelRefProps;
}

export const LIBRARY_PANEL_REF_TYPE = "Grafana::LibraryPanelRef";

const RefBase = createProperty(LIBRARY_PANEL_REF_TYPE, "grafana") as unknown as (this: object, props: Record<string, unknown>) => void;

/** A library panel placed on a dashboard: where it goes, and its id there. */
export const LibraryPanelRef = function (this: object, props: LibraryPanelRefProps) {
  const lp = props?.libraryPanel as unknown;
  const external = typeof lp === "object" && lp !== null && typeof (lp as ExternalLibraryPanel).uid === "string" && typeof (lp as ExternalLibraryPanel).name === "string";
  if (!isLibraryPanelEntity(lp) && !external) throw new Error("grafana: a LibraryPanelRef's libraryPanel must be a LibraryPanel or a { uid, name } of one in Grafana");
  RefBase.call(this, props as unknown as Record<string, unknown>);
} as unknown as new (props: LibraryPanelRefProps) => LibraryPanelRefEntity;
Object.defineProperty(LibraryPanelRef, "name", { value: "LibraryPanelRef" });

export function isLibraryPanelRefEntity(value: unknown): value is LibraryPanelRefEntity {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Declarable).entityType === LIBRARY_PANEL_REF_TYPE &&
    (value as Declarable).lexicon === "grafana"
  );
}

/** What a reference names: the uid and name, and the `LibraryPanel` when the project declares it. */
export function referencedLibraryPanel(item: LibraryPanelEntity | LibraryPanelRefEntity): { uid: string; name: string; entity?: LibraryPanelEntity } {
  const lp = isLibraryPanelEntity(item) ? item : item.props.libraryPanel;
  if (isLibraryPanelEntity(lp)) return { uid: lp.uid, name: lp.props.name, entity: lp };
  return { uid: lp.uid, name: lp.name };
}
