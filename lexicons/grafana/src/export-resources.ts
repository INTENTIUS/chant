/**
 * Live export for grafana (#2946): `chant import --from <env>` writes the
 * environment's dashboards and datasources as chant TypeScript.
 *
 * All I/O is here; the mapping is pure in ./import/live-export.ts, and the
 * IR it builds is the importer's own (#2945), so a dashboard exported from
 * Grafana and the same dashboard's JSON given to `chant import` generate the
 * same source through the same `GrafanaGenerator`.
 *
 * - Every dashboard in the organisation is listed over the API the thin
 *   read uses (`/apis/dashboard.grafana.app`, or `/api/search` plus
 *   `/api/dashboards/uid` on Grafana 11). A v2 dashboard is left out with a
 *   warning (#2947).
 * - Every datasource is read by uid, for `secureJsonFields`; secrets come
 *   back as key names only (see `datasourceProps`).
 * - `selector.type` is `Grafana::Dashboard` or `Grafana::Datasource`;
 *   `selector.name` is a uid.
 * - `owned` keeps only dashboards that are chant's (./ownership.ts), and
 *   leaves datasources out, since their ownership cannot be read. There is no
 *   project here to name its providers, so a file-provisioned dashboard is
 *   chant's when its provider is the default one, `chant`.
 * - `verbatim` keeps datasource keys at the API's "not set" values. A
 *   dashboard is always planned by the importer, which leaves out keys at
 *   Grafana's defaults either way.
 */

import type { ExportedTemplate, ResourceSelector } from "@intentius/chant/lexicon";
import { bindGrafana, type BindOptions } from "./api/bind";
import { classicDashboardOf, listDashboards } from "./api/dashboards";
import { listDatasources, readDatasource } from "./api/datasources";
import { DASHBOARD_TYPE } from "./dashboard";
import { DATASOURCE_TYPE } from "./datasource";
import { exportTemplate } from "./import/live-export";
import { DEFAULT_PROVIDER_NAME, dashboardOwnership } from "./ownership";

type Json = Record<string, unknown>;

export interface GrafanaExportOptions extends Omit<BindOptions, "environment"> {
  environment: string;
  stack?: string;
  region?: string;
  selector?: ResourceSelector;
  owned?: boolean;
  verbatim?: boolean;
}

export async function exportResources(options: GrafanaExportOptions): Promise<ExportedTemplate> {
  const client = await bindGrafana({ ...options });
  const type = options.selector?.type;
  const name = options.selector?.name;
  const warnings: string[] = [];

  const dashboards: Array<{ json: Json }> = [];
  if (type === undefined || type === DASHBOARD_TYPE) {
    const providers = new Set([DEFAULT_PROVIDER_NAME]);
    for (const live of await listDashboards(client)) {
      if (name !== undefined && live.uid !== name) continue;
      if (options.owned && dashboardOwnership(live, providers).ownership !== "owned") continue;
      const classic = classicDashboardOf(live);
      if ("unsupported" in classic) {
        warnings.push(`dashboard ${live.uid} is not exported: ${classic.unsupported}`);
        continue;
      }
      dashboards.push({ json: classic.json });
    }
  }

  const datasources: Json[] = [];
  if ((type === undefined || type === DATASOURCE_TYPE) && !options.owned) {
    for (const summary of await listDatasources(client)) {
      const uid = typeof summary.uid === "string" ? summary.uid : undefined;
      if (!uid || (name !== undefined && uid !== name)) continue;
      const read = await readDatasource(client, uid);
      if ("present" in read) datasources.push(read.present);
    }
  } else if (options.owned && (type === undefined || type === DATASOURCE_TYPE)) {
    warnings.push("datasources are not exported with --owned: Grafana's datasource API carries no ownership marker");
  }

  const ir = exportTemplate({ dashboards, datasources, keepDefaults: options.verbatim });
  return { ...ir, warnings: [...warnings, ...(ir.warnings ?? [])] };
}
