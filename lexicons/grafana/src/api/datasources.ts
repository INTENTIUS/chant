/**
 * Reading datasources (#2946), over `GET /api/datasources/uid/<uid>` and
 * `GET /api/datasources`. Grafana 12.4 and 13.2 serve no general
 * datasource resource under `/apis`, so this is the one datasource API both
 * have, and it carries no labels or annotations: a datasource's ownership
 * cannot be read (see ../ownership.ts).
 *
 * The API never returns secret values. `secureJsonFields` says which
 * secrets are set, and that is all this reads of them.
 */

import type { GrafanaClient } from "./client";

type Json = Record<string, unknown>;

export type DatasourceRead = { readonly present: Json; readonly address: string } | { readonly absent: true; readonly address: string };

export function datasourcePath(uid: string): string {
  return `/api/datasources/uid/${encodeURIComponent(uid)}`;
}

/** Read one datasource by uid. Throws `GrafanaApiError` for anything but a 2xx or a 404. */
export async function readDatasource(client: GrafanaClient, uid: string): Promise<DatasourceRead> {
  const address = datasourcePath(uid);
  const body = await client.get<Json>(address);
  return body === undefined ? { absent: true, address } : { present: body, address };
}

/** Every datasource in the organisation. */
export async function listDatasources(client: GrafanaClient): Promise<Json[]> {
  const list = await client.get<unknown[]>("/api/datasources");
  return (list ?? []).filter((d): d is Json => typeof d === "object" && d !== null && !Array.isArray(d));
}
