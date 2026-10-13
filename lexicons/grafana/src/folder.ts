/**
 * `Folder`: a Grafana folder with a stable uid, nested with `parent`.
 *
 * A dashboard names its folder either as a path string
 * (`folder: "Platform/Kubernetes"`) or as a `Folder`. Both give the same
 * folders: one per level, each with the uid `folderUidFor` makes from its
 * path unless a `Folder` sets one. A `Folder` is needed only to pin a uid
 * (for links, alert rules, permissions set elsewhere) or to declare a folder
 * that holds no dashboard yet.
 *
 * How each delivery carries it:
 *
 * - File provisioning writes the dashboard under `dashboards/<level>/...`,
 *   and a provider with `foldersFromFilesStructure` makes one folder per
 *   level (nested on Grafana 13.1 and later; GRAF109 says what earlier
 *   versions do). Grafana finds each level's folder by title under its
 *   parent and creates it when missing, with a uid of its own: file
 *   provisioning has no field for a nested folder's uid. A folder the API
 *   applier made first keeps the uid it was given. A `DashboardProvider`
 *   whose `folder` is a root-level `Folder` writes its `folderUid`.
 * - The API applier (./api/apply.ts) creates every folder with its uid and
 *   parent, parents first.
 * - Observation reads a dashboard's folder back as its path, and a `Folder`
 *   by its uid.
 *
 * The rules for turning folders into uids and parents are in one place,
 * `resolveFolders` in ./api/folders.ts, which the build, the applier and
 * observation all call.
 */

import { createResource } from "@intentius/chant/runtime";
import type { Declarable } from "@intentius/chant/declarable";
import { slugUid } from "./util";

export interface FolderProps {
  /** The title Grafana shows. A single level: nest with `parent`, not with `/`. */
  title: string;
  /**
   * Stable id: letters, digits, `-` and `_`, at most 40 characters, and not
   * `general`, which Grafana keeps for its root. Defaults to the folder's
   * path as a uid (`Platform/Kubernetes` becomes `platform-kubernetes`), the
   * same uid a dashboard's `folder: "Platform/Kubernetes"` gives it.
   */
  uid?: string;
  /** The folder this one is in. Leave it out for a folder at the root. */
  parent?: FolderEntity;
}

export interface FolderEntity extends Declarable {
  readonly props: FolderProps;
  /** The uid Grafana gives the folder: its own, else one made from its path. */
  readonly uid: string;
  /** Its titles from the root, joined with `/`: the directory the build writes it to. */
  readonly path: string;
}

export const FOLDER_TYPE = "Grafana::Folder";

/**
 * The levels of a folder path, as the build writes them to directories:
 * split on `/`, a backslash made `-`, leading dots and surrounding blanks
 * dropped, so no level names a directory outside `dashboards/`. Empty levels
 * are dropped; no levels at all is the General folder.
 */
export function folderLevels(path: string): string[] {
  return path
    .split("/")
    .map((level) => level.replace(/\\+/g, "-").trim().replace(/^\.+/, "").trim())
    .filter((level) => level !== "");
}

/** The uid chant gives a folder it only knows by path. Stable, so a second apply finds the folder the first one made. */
export function folderUidFor(path: string): string {
  return slugUid(folderLevels(path).join("/"));
}

const Base = createResource(FOLDER_TYPE, "grafana", {}) as unknown as (this: object, props: Record<string, unknown>) => void;

/** A Grafana folder. */
export const Folder = function (this: object, props: FolderProps) {
  const title = props.title;
  if (typeof title !== "string" || folderLevels(title).length !== 1 || folderLevels(title)[0] !== title) {
    throw new Error(
      `grafana: Folder title ${JSON.stringify(title)} is not one folder level: use parent to nest folders, and leave out "/", "\\", leading dots and surrounding blanks, which file provisioning cannot write as a directory`,
    );
  }
  if (props.parent !== undefined && !isFolderEntity(props.parent)) throw new Error(`grafana: Folder "${title}" has a parent that is not a Folder`);
  Base.call(this, props as unknown as Record<string, unknown>);
  const path = props.parent ? `${props.parent.path}/${title}` : title;
  Object.defineProperty(this, "path", { value: path, enumerable: false });
  Object.defineProperty(this, "uid", { value: props.uid ?? folderUidFor(path), enumerable: false });
} as unknown as new (props: FolderProps) => FolderEntity;
Object.defineProperty(Folder, "name", { value: "Folder" });

export function isFolderEntity(value: unknown): value is FolderEntity {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Declarable).entityType === FOLDER_TYPE &&
    (value as Declarable).lexicon === "grafana"
  );
}

/** A folder's uid from its props, as observation sees them (the props of a `Folder`, parents included). */
export function folderUidOf(props: Record<string, unknown>): string | undefined {
  if (typeof props.uid === "string" && props.uid !== "") return props.uid;
  const path = folderPathOf(props);
  return path ? folderUidFor(path) : undefined;
}

/** A folder's path from its props, walking `parent`. */
export function folderPathOf(props: Record<string, unknown>): string | undefined {
  if (typeof props.title !== "string") return undefined;
  const parent = props.parent as { props?: Record<string, unknown> } | undefined;
  if (!parent) return props.title;
  const up = parent.props ? folderPathOf(parent.props) : undefined;
  return up === undefined ? undefined : `${up}/${props.title}`;
}
