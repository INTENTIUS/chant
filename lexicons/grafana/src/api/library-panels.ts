/**
 * Library panels, for the API applier (#2948).
 *
 * A dashboard that uses a library panel holds only a reference to it
 * (`{ libraryPanel: { uid, name } }`); the panel itself lives in Grafana's
 * library, and an exported dashboard carries its model in `__elements`,
 * keyed by uid. The applier writes each element to the library over
 * `/api/library-elements` before the dashboards that reference it, and
 * sends the dashboards without `__elements`, `__inputs` or `__requires`,
 * which are export-only keys Grafana does not store.
 *
 * The library elements API is the same on Grafana 11, 12.4 and 13.2. It has
 * no labels, so a library panel cannot carry chant's marker and is never
 * pruned (the applier reports that as `not-prunable`). An update needs the
 * element's current `version`, which the read supplies.
 */

import type { GrafanaClient } from "./client";
import { send } from "./folders";
import { converged } from "./converge";

type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** `kind` of a library panel in the library elements API (2 is a library variable). */
export const LIBRARY_PANEL_KIND = 1;

/** Keys an exported dashboard carries that Grafana does not store. */
export const EXPORT_ONLY_KEYS: readonly string[] = ["__elements", "__inputs", "__requires"];

/** One library panel a build needs. */
export interface LibraryPanelPlan {
  readonly uid: string;
  readonly name: string;
  readonly model: Json;
  /** The folder it goes in: the element's `folderUid`, else that of the first dashboard that carries it. Absent for the General folder. */
  readonly folderUid?: string;
}

/**
 * The library panels in a dashboard's `__elements`. An element that is not a
 * panel (a library variable), or that has no uid, name or model, is not
 * something the library panel API can take; it is returned in `skipped`.
 */
export function libraryPanelsOf(dashboard: Json, folderUid?: string): { panels: LibraryPanelPlan[]; skipped: string[] } {
  const elements = dashboard.__elements;
  const panels: LibraryPanelPlan[] = [];
  const skipped: string[] = [];
  if (!isObject(elements)) return { panels, skipped };
  for (const [key, el] of Object.entries(elements)) {
    if (!isObject(el)) {
      skipped.push(key);
      continue;
    }
    const uid = typeof el.uid === "string" && el.uid !== "" ? el.uid : key;
    const kind = el.kind ?? LIBRARY_PANEL_KIND;
    if (kind !== LIBRARY_PANEL_KIND || typeof el.name !== "string" || !isObject(el.model)) {
      skipped.push(uid);
      continue;
    }
    // A build writes the folder a `LibraryPanel` names into its element; an export's elements have none, and go in the dashboard's.
    const inFolder = typeof el.folderUid === "string" && el.folderUid !== "" ? el.folderUid : folderUid;
    panels.push({ uid, name: el.name, model: el.model, ...(inFolder ? { folderUid: inFolder } : {}) });
  }
  return { panels, skipped };
}

/** A dashboard without the export-only keys, as the applier sends it. */
export function withoutExportKeys(dashboard: Json): Json {
  const out: Json = { ...dashboard };
  for (const k of EXPORT_ONLY_KEYS) delete out[k];
  return out;
}

export function libraryPanelPath(uid: string): string {
  return `/api/library-elements/${encodeURIComponent(uid)}`;
}

/**
 * Create or update one library panel. Unchanged when its name, folder and
 * model already match; nothing is written then.
 */
export async function ensureLibraryPanel(
  client: GrafanaClient,
  plan: LibraryPanelPlan,
): Promise<{ action: "created" | "updated" | "unchanged"; address: string }> {
  const address = libraryPanelPath(plan.uid);
  const live = (await client.get<{ result?: Json }>(address))?.result;
  const body = { name: plan.name, kind: LIBRARY_PANEL_KIND, model: plan.model, folderUid: plan.folderUid ?? "" };
  if (!live) {
    await send(client, "POST", "/api/library-elements", { uid: plan.uid, ...body });
    return { action: "created", address };
  }
  const liveFolder = typeof live.folderUid === "string" ? live.folderUid : "";
  if (live.name === plan.name && liveFolder === (plan.folderUid ?? "") && converged(plan.model, live.model)) {
    return { action: "unchanged", address };
  }
  await send(client, "PATCH", address, { ...body, version: typeof live.version === "number" ? live.version : 1 });
  return { action: "updated", address };
}
